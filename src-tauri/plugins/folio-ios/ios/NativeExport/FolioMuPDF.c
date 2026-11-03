#include "FolioMuPDF.h"
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void fail_message(char *out, size_t capacity, const char *message)
{
    if (out && capacity) snprintf(out, capacity, "%s", message ? message : "Native PDF operation failed.");
}

static pdf_document *open_pdf(fz_context *ctx, const char *path, const char *password)
{
    pdf_document *document = pdf_open_document(ctx, path);
    fz_try(ctx) {
        if (pdf_needs_password(ctx, document) && !pdf_authenticate_password(ctx, document, password ? password : ""))
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "The PDF password is missing or incorrect.");
    }
    fz_catch(ctx) { pdf_drop_document(ctx, document); fz_rethrow(ctx); }
    return document;
}

static char *copy_text(fz_context *ctx, const char *text, size_t *budget)
{
    size_t length = strlen(text ? text : "");
    if (length > *budget) fz_throw(ctx, FZ_ERROR_LIMIT, "Page annotation metadata exceeds the bounded reader payload.");
    char *copy = malloc(length + 1);
    if (!copy) fz_throw(ctx, FZ_ERROR_SYSTEM, "Out of memory reading annotation metadata.");
    memcpy(copy, text ? text : "", length + 1); *budget -= length;
    return copy;
}

void folio_pdf_free_annotations(FolioSourceAnnotation *items, size_t count)
{
    if (!items) return;
    for (size_t index = 0; index < count; ++index) {
        free(items[index].name); free(items[index].contents);
        free(items[index].author); free(items[index].quads);
        free(items[index].path_sizes); free(items[index].ink_points);
    }
    free(items);
}

/* Reads one page's editable annotations from an open document; throws on error. */
static void read_annotations(fz_context *ctx, pdf_document *document, int32_t page,
    FolioSourceAnnotation **out_items, size_t *out_count)
{
    FolioSourceAnnotation *items = NULL;
    size_t count = 0;
    fz_var(items); fz_var(count);
    fz_try(ctx) {
        if (page <= 0 || page > pdf_count_pages(ctx, document)) fz_throw(ctx, FZ_ERROR_ARGUMENT, "PDF page does not exist.");
        pdf_obj *array = pdf_dict_get(ctx, pdf_lookup_page_obj(ctx, document, page - 1), PDF_NAME(Annots));
        int length = pdf_array_len(ctx, array);
        if (length > 20000) fz_throw(ctx, FZ_ERROR_LIMIT, "This page contains too many annotations to edit in the reader.");
        items = calloc(length ? (size_t)length : 1, sizeof(*items));
        if (!items) fz_throw(ctx, FZ_ERROR_SYSTEM, "Out of memory reading PDF annotations.");
        size_t budget = 8 * 1024 * 1024;
        for (int index = 0; index < length; ++index) {
            pdf_obj *object = pdf_array_get(ctx, array, index);
            const char *type = pdf_dict_get_name(ctx, object, PDF_NAME(Subtype));
            int kind = !strcmp(type, "Highlight") ? 1 : !strcmp(type, "Text") ? 2 : !strcmp(type, "Ink") ? 3 : 0;
            if (!kind) continue;
            FolioSourceAnnotation *item = &items[count++];
            item->index = index; item->kind = kind;
            item->flags = pdf_dict_get_int(ctx, object, PDF_NAME(F));
            fz_rect rect = pdf_dict_get_rect(ctx, object, PDF_NAME(Rect));
            item->rect[0] = rect.x0; item->rect[1] = rect.y0; item->rect[2] = rect.x1; item->rect[3] = rect.y1;
            item->opacity = pdf_dict_get_real_default(ctx, object, PDF_NAME(CA), 1);
            item->modified_seconds = pdf_dict_get_date(ctx, object, PDF_NAME(M));
            item->name = copy_text(ctx, pdf_dict_get_text_string(ctx, object, PDF_NAME(NM)), &budget);
            item->contents = copy_text(ctx, pdf_dict_get_text_string(ctx, object, PDF_NAME(Contents)), &budget);
            item->author = copy_text(ctx, pdf_dict_get_text_string(ctx, object, PDF_NAME(T)), &budget);
            pdf_obj *color = pdf_dict_get(ctx, object, PDF_NAME(C));
            int components = pdf_array_len(ctx, color);
            if (components == 1) item->color[0] = item->color[1] = item->color[2] = pdf_array_get_real(ctx, color, 0);
            else if (components == 3) for (int n = 0; n < 3; ++n) item->color[n] = pdf_array_get_real(ctx, color, n);
            else if (components == 4) {
                float cmyk[4]; for (int n = 0; n < 4; ++n) cmyk[n] = pdf_array_get_real(ctx, color, n);
                fz_convert_color(ctx, fz_device_cmyk(ctx), cmyk, fz_device_rgb(ctx), item->color, NULL, fz_default_color_params);
            } else { item->color[0] = .96f; item->color[1] = .84f; item->color[2] = .43f; }
            pdf_obj *quads = pdf_dict_get(ctx, object, PDF_NAME(QuadPoints));
            int points = pdf_array_len(ctx, quads);
            if (kind == 1 && points >= 8 && points % 8 == 0) {
                size_t bytes = (size_t)points * sizeof(float);
                if (bytes > budget) fz_throw(ctx, FZ_ERROR_LIMIT, "Highlight geometry exceeds the bounded reader payload.");
                item->quads = malloc(bytes); if (!item->quads) fz_throw(ctx, FZ_ERROR_SYSTEM, "Out of memory reading highlight geometry.");
                item->quad_count = (size_t)points / 8; budget -= bytes;
                for (int n = 0; n < points; ++n) item->quads[n] = pdf_array_get_real(ctx, quads, n);
            }
            if (kind == 3) {
                pdf_obj *paths = pdf_dict_get(ctx, object, PDF_NAME(InkList));
                int path_count = pdf_array_len(ctx, paths);
                if (path_count < 1 || path_count > 20000) fz_throw(ctx, FZ_ERROR_LIMIT, "Invalid or excessive ink paths.");
                size_t sizes_bytes = (size_t)path_count * sizeof(int32_t), total = 0;
                if (sizes_bytes > budget) fz_throw(ctx, FZ_ERROR_LIMIT, "Ink geometry exceeds the bounded reader payload.");
                item->path_sizes = malloc(sizes_bytes);
                if (!item->path_sizes) fz_throw(ctx, FZ_ERROR_SYSTEM, "Out of memory reading ink paths.");
                item->path_count = (size_t)path_count; budget -= sizes_bytes;
                for (int n = 0; n < path_count; ++n) {
                    int length = pdf_array_len(ctx, pdf_array_get(ctx, paths, n));
                    if (length < 4 || length > 20000 || length % 2) fz_throw(ctx, FZ_ERROR_LIMIT, "Invalid ink path geometry.");
                    item->path_sizes[n] = length; total += (size_t)length;
                    if (total > budget / sizeof(float)) fz_throw(ctx, FZ_ERROR_LIMIT, "Ink geometry exceeds the bounded reader payload.");
                }
                item->ink_points = malloc(total * sizeof(float));
                if (!item->ink_points) fz_throw(ctx, FZ_ERROR_SYSTEM, "Out of memory reading ink geometry.");
                budget -= total * sizeof(float);
                size_t offset = 0;
                for (int n = 0; n < path_count; ++n) {
                    pdf_obj *path = pdf_array_get(ctx, paths, n);
                    for (int k = 0; k < item->path_sizes[n]; ++k) {
                        float point = pdf_array_get_real(ctx, path, k);
                        if (!isfinite(point)) fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid ink coordinate.");
                        item->ink_points[offset++] = point;
                    }
                }
                pdf_obj *border = pdf_dict_get(ctx, object, PDF_NAME(BS));
                item->stroke_width = border ? pdf_dict_get_real_default(ctx, border, PDF_NAME(W), 1) :
                    pdf_array_len(ctx, pdf_dict_get(ctx, object, PDF_NAME(Border))) >= 3 ? pdf_array_get_real(ctx, pdf_dict_get(ctx, object, PDF_NAME(Border)), 2) : 1;
                if (!isfinite(item->stroke_width) || item->stroke_width <= 0) item->stroke_width = 1;
            }
        }
        *out_items = items; *out_count = count; items = NULL;
    }
    fz_always(ctx) { folio_pdf_free_annotations(items, count); }
    fz_catch(ctx) { fz_rethrow(ctx); }
}

int folio_pdf_read_annotations(const char *path, const char *password, int32_t page,
    FolioSourceAnnotation **out_items, size_t *out_count, char *error, size_t error_capacity)
{
    fz_context *ctx = fz_new_context(NULL, NULL, 32 * 1024 * 1024);
    pdf_document *document = NULL;
    int status = -1;
    if (!ctx) { fail_message(error, error_capacity, "Out of memory opening PDF metadata."); return -1; }
    if (!out_items || !out_count) { fz_drop_context(ctx); return -1; }
    *out_items = NULL; *out_count = 0;
    fz_var(document); fz_var(status);
    fz_try(ctx) {
        document = open_pdf(ctx, path, password);
        read_annotations(ctx, document, page, out_items, out_count); status = 0;
    }
    fz_always(ctx) { pdf_drop_document(ctx, document); }
    fz_catch(ctx) { fail_message(error, error_capacity, fz_caught_message(ctx)); }
    fz_drop_context(ctx); return status;
}

static int compare_pages(const void *a, const void *b) { int x = *(const int *)a, y = *(const int *)b; return (x > y) - (x < y); }

static void edit_page(fz_context *ctx, pdf_document *document, int number,
    const FolioOverlay *overlays, size_t overlay_count, const FolioRemoval *removals, size_t removal_count)
{
    pdf_page *page = NULL;
    pdf_obj **targets = NULL;
    size_t target_count = 0;
    fz_var(page); fz_var(targets); fz_var(target_count);
    fz_try(ctx) {
        page = pdf_load_page(ctx, document, number - 1);
        targets = calloc(removal_count ? removal_count : 1, sizeof(*targets));
        if (!targets) fz_throw(ctx, FZ_ERROR_SYSTEM, "Out of memory resolving source annotations.");
        pdf_obj *array = pdf_dict_get(ctx, pdf_lookup_page_obj(ctx, document, number - 1), PDF_NAME(Annots));
        for (size_t index = 0; index < removal_count; ++index) if (removals[index].page == number) {
            int raw_index = removals[index].index;
            if (raw_index < 0 || raw_index >= pdf_array_len(ctx, array)) fz_throw(ctx, FZ_ERROR_ARGUMENT, "A source annotation no longer matches the PDF.");
            pdf_obj *object = pdf_array_get(ctx, array, raw_index);
            const char *type = pdf_dict_get_name(ctx, object, PDF_NAME(Subtype));
            if (strcmp(type, "Highlight") && strcmp(type, "Text") && strcmp(type, "Ink")) fz_throw(ctx, FZ_ERROR_ARGUMENT, "This source annotation cannot be edited in Folio.");
            targets[target_count++] = pdf_keep_obj(ctx, object);
        }
        /* Resolve all raw indices before mutation; deleting Popup children may
         * otherwise shift subsequent annotation indices. */
        for (size_t index = 0; index < target_count; ++index) {
            pdf_annot *found = NULL;
            pdf_obj *target = pdf_resolve_indirect(ctx, targets[index]);
            for (pdf_annot *annotation = pdf_first_annot(ctx, page); annotation; annotation = pdf_next_annot(ctx, annotation))
                if (pdf_resolve_indirect(ctx, pdf_annot_obj(ctx, annotation)) == target) { found = annotation; break; }
            if (!found) fz_throw(ctx, FZ_ERROR_ARGUMENT, "The editable source annotation was not found.");
            pdf_delete_annot(ctx, page, found);
        }
        for (size_t index = 0; index < overlay_count; ++index) if (overlays[index].page == number) {
            const FolioOverlay *item = &overlays[index];
            if ((item->kind != 1 && item->kind != 2 && item->kind != 3) || !item->name || !item->contents || !item->author ||
                !isfinite(item->opacity) || item->opacity < 0 || item->opacity > 1 || item->quad_count > 131072)
                fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid PDF annotation payload.");
            for (int n = 0; n < 4; ++n) if (!isfinite(item->rect[n])) fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid PDF annotation coordinates.");
            if (item->rect[2] <= item->rect[0] || item->rect[3] <= item->rect[1]) fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid PDF annotation bounds.");
            pdf_annot *annotation = pdf_create_annot_raw(ctx, page, item->kind == 1 ? PDF_ANNOT_HIGHLIGHT : item->kind == 3 ? PDF_ANNOT_INK : PDF_ANNOT_TEXT);
            pdf_obj *object = pdf_annot_obj(ctx, annotation);
            pdf_dict_put_rect(ctx, object, PDF_NAME(Rect), fz_make_rect(item->rect[0], item->rect[1], item->rect[2], item->rect[3]));
            pdf_set_annot_color(ctx, annotation, 3, item->color);
            pdf_set_annot_opacity(ctx, annotation, item->opacity);
            pdf_set_annot_name(ctx, annotation, item->name);
            pdf_set_annot_contents(ctx, annotation, item->contents);
            pdf_set_annot_author(ctx, annotation, item->author);
            pdf_set_annot_modification_date(ctx, annotation, item->modified_seconds);
            pdf_set_annot_flags(ctx, annotation, PDF_ANNOT_IS_PRINT);
            if (item->kind == 2) pdf_set_annot_icon_name(ctx, annotation, "Note");
            if (item->kind == 1) {
                pdf_obj *quads = pdf_dict_put_array(ctx, object, PDF_NAME(QuadPoints), (int)item->quad_count * 8);
                if (item->quad_count && !item->quads) fz_throw(ctx, FZ_ERROR_ARGUMENT, "Missing highlight geometry.");
                for (size_t n = 0; n < item->quad_count * 8; ++n) {
                    if (!isfinite(item->quads[n])) fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid highlight geometry.");
                    pdf_array_push_real(ctx, quads, item->quads[n]);
                }
            }
            if (item->kind == 3) {
                if (!isfinite(item->stroke_width) || item->stroke_width <= 0 || item->stroke_width > 50 ||
                    !item->path_count || item->path_count > 20000 || !item->path_sizes || !item->ink_points)
                    fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid ink annotation payload.");
                pdf_set_annot_border_width(ctx, annotation, item->stroke_width);
                pdf_obj *paths = pdf_dict_put_array(ctx, object, PDF_NAME(InkList), (int)item->path_count);
                size_t offset = 0;
                for (size_t n = 0; n < item->path_count; ++n) {
                    int length = item->path_sizes[n];
                    if (length < 4 || length > 20000 || length % 2 || offset + (size_t)length > 1048576)
                        fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid ink path geometry.");
                    pdf_obj *path = pdf_array_push_array(ctx, paths, length);
                    for (int k = 0; k < length; ++k) {
                        float point = item->ink_points[offset++];
                        if (!isfinite(point)) fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid ink coordinate.");
                        pdf_array_push_real(ctx, path, point);
                    }
                }
            }
            /* Synthesise only this newly created appearance. Unvisited widgets,
             * stamps and original /AP streams are never regenerated. */
            pdf_dirty_annot(ctx, annotation); pdf_update_annot(ctx, annotation);
        }
    }
    fz_always(ctx) {
        for (size_t index = 0; index < target_count; ++index) pdf_drop_obj(ctx, targets[index]);
        free(targets); pdf_drop_page(ctx, page);
    }
    fz_catch(ctx) { fz_rethrow(ctx); }
}

int folio_pdf_export(const char *source, const char *output, const char *password,
    const FolioOverlay *overlays, size_t overlay_count, const FolioRemoval *removals, size_t removal_count,
    char *error, size_t error_capacity)
{
    fz_context *ctx = fz_new_context(NULL, NULL, 32 * 1024 * 1024);
    pdf_document *document = NULL;
    int *pages = NULL;
    int status = -1;
    if (!ctx) { fail_message(error, error_capacity, "Out of memory opening native PDF export."); return -1; }
    fz_var(document); fz_var(pages); fz_var(status);
    fz_try(ctx) {
        if (!source || !output || !strcmp(source, output) || (overlay_count && !overlays) || (removal_count && !removals) || overlay_count > 100000 || removal_count > 100000)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid native PDF export request.");
        document = open_pdf(ctx, source, password);
        if (!pdf_has_permission(ctx, document, FZ_PERMISSION_ANNOTATE)) fz_throw(ctx, FZ_ERROR_ARGUMENT, "This PDF does not permit annotations.");
        if (!pdf_can_be_saved_incrementally(ctx, document)) fz_throw(ctx, FZ_ERROR_ARGUMENT, "This PDF requires repair and cannot preserve its original objects during annotation export.");
        size_t total = overlay_count + removal_count;
        pages = malloc((total ? total : 1) * sizeof(*pages));
        if (!pages) fz_throw(ctx, FZ_ERROR_SYSTEM, "Out of memory preparing PDF export.");
        for (size_t index = 0; index < overlay_count; ++index) pages[index] = overlays[index].page;
        for (size_t index = 0; index < removal_count; ++index) pages[overlay_count + index] = removals[index].page;
        qsort(pages, total, sizeof(*pages), compare_pages);
        int page_count = pdf_count_pages(ctx, document);
        for (size_t index = 0; index < total; ++index) if (index == 0 || pages[index] != pages[index - 1]) {
            if (pages[index] <= 0 || pages[index] > page_count) fz_throw(ctx, FZ_ERROR_ARGUMENT, "PDF export page does not exist.");
            edit_page(ctx, document, pages[index], overlays, overlay_count, removals, removal_count);
        }
        pdf_write_options options = pdf_default_write_options;
        options.do_incremental = 1; options.do_encrypt = PDF_ENCRYPT_KEEP;
        options.do_garbage = 0; options.do_clean = 0; options.do_sanitize = 0;
        options.do_appearance = 0; options.do_preserve_metadata = 1; options.dont_regenerate_id = 1;
        /* MuPDF copies the original using 4096-byte stream buffers into this
         * new destination, then appends only changed objects and a new xref. */
        pdf_save_document(ctx, document, output, &options); status = 0;
    }
    fz_always(ctx) { free(pages); pdf_drop_document(ctx, document); }
    fz_catch(ctx) { fail_message(error, error_capacity, fz_caught_message(ctx)); }
    fz_drop_context(ctx); return status;
}

const char *folio_pdf_engine_version(void) { return FZ_VERSION; }

/* ---- File-backed reader ------------------------------------------------ */

struct folio_reader { fz_context *ctx; pdf_document *document; int locked; };

void folio_reader_free(void *pointer) { free(pointer); }

static void json_string(fz_context *ctx, fz_buffer *out, const char *text)
{
    fz_append_byte(ctx, out, '"');
    for (const unsigned char *c = (const unsigned char *)(text ? text : ""); *c; ++c) {
        if (*c == '"' || *c == '\\') { fz_append_byte(ctx, out, '\\'); fz_append_byte(ctx, out, *c); }
        else if (*c < 0x20) fz_append_printf(ctx, out, "\\u%04x", *c);
        else fz_append_byte(ctx, out, *c);
    }
    fz_append_byte(ctx, out, '"');
}
static void json_number(fz_context *ctx, fz_buffer *out, float value)
{
    fz_append_printf(ctx, out, "%g", isfinite(value) ? value : 0);
}
static void json_rect(fz_context *ctx, fz_buffer *out, fz_rect r)
{
    fz_append_byte(ctx, out, '[');
    json_number(ctx, out, r.x0); fz_append_byte(ctx, out, ',');
    json_number(ctx, out, r.y0); fz_append_byte(ctx, out, ',');
    json_number(ctx, out, r.x1); fz_append_byte(ctx, out, ',');
    json_number(ctx, out, r.y1); fz_append_byte(ctx, out, ']');
}
/* Hands the buffer's text to the caller as a malloc'd C string. */
static char *json_result(fz_context *ctx, fz_buffer *out)
{
    unsigned char *data;
    size_t length = fz_buffer_storage(ctx, out, &data);
    char *copy = malloc(length + 1);
    if (!copy) fz_throw(ctx, FZ_ERROR_SYSTEM, "Out of memory returning PDF metadata.");
    memcpy(copy, data, length); copy[length] = 0;
    return copy;
}

static int document_signed(fz_context *ctx, pdf_document *document)
{
    pdf_obj *root = pdf_dict_get(ctx, pdf_trailer(ctx, document), PDF_NAME(Root));
    if (pdf_dict_get_int(ctx, pdf_dict_get(ctx, root, PDF_NAME(AcroForm)), PDF_NAME(SigFlags)) & 1) return 1;
    return pdf_dict_get(ctx, pdf_dict_get(ctx, root, PDF_NAME(Perms)), PDF_NAME(DocMDP)) != NULL;
}

/* The page's crop box (within its media box) in PDF user space, and its /Rotate. */
static fz_rect page_view(fz_context *ctx, pdf_obj *page, int *rotation)
{
    fz_rect media = pdf_to_rect(ctx, pdf_dict_get_inheritable(ctx, page, PDF_NAME(MediaBox)));
    if (fz_is_empty_rect(media)) media = fz_make_rect(0, 0, 612, 792);
    fz_rect crop = pdf_to_rect(ctx, pdf_dict_get_inheritable(ctx, page, PDF_NAME(CropBox)));
    if (!fz_is_empty_rect(crop)) crop = fz_intersect_rect(crop, media);
    if (fz_is_empty_rect(crop)) crop = media;
    if (rotation) {
        int value = pdf_to_int(ctx, pdf_dict_get_inheritable(ctx, page, PDF_NAME(Rotate)));
        value = ((value % 360) + 360) % 360;
        *rotation = value - value % 90;
    }
    return crop;
}

/* MuPDF's page space -> PDF user space. */
static fz_matrix to_user(fz_context *ctx, pdf_page *page)
{
    fz_rect media; fz_matrix ctm;
    pdf_page_transform(ctx, page, &media, &ctm);
    return fz_invert_matrix(ctm);
}

static pdf_page *reader_page(fz_context *ctx, folio_reader *reader, int32_t number)
{
    if (reader->locked) fz_throw(ctx, FZ_ERROR_ARGUMENT, "The PDF password is missing or incorrect.");
    if (number <= 0 || number > pdf_count_pages(ctx, reader->document)) fz_throw(ctx, FZ_ERROR_ARGUMENT, "PDF page does not exist.");
    return pdf_load_page(ctx, reader->document, number - 1);
}

int folio_reader_open(const char *path, const char *password, folio_reader **out, char **json,
    char *error, size_t error_capacity)
{
    /* MuPDF's resource store (fonts, images) stays bounded however big the book is. */
    fz_context *ctx = fz_new_context(NULL, NULL, 96 * 1024 * 1024);
    folio_reader *reader = NULL;
    fz_buffer *buffer = NULL;
    int status = -1;
    if (!ctx) { fail_message(error, error_capacity, "Out of memory opening the PDF."); return -1; }
    if (!out || !json) { fz_drop_context(ctx); return -1; }
    *out = NULL; *json = NULL;
    fz_var(reader); fz_var(buffer); fz_var(status);
    fz_try(ctx) {
        fz_register_document_handlers(ctx);
        reader = calloc(1, sizeof(*reader));
        if (!reader) fz_throw(ctx, FZ_ERROR_SYSTEM, "Out of memory opening the PDF.");
        reader->ctx = ctx;
        reader->document = pdf_open_document(ctx, path);
        pdf_document *document = reader->document;
        reader->locked = pdf_needs_password(ctx, document) && !pdf_authenticate_password(ctx, document, password ? password : "");
        /* MuPDF looks up the structure tree's ParentTree each time it runs a page, and a book
         * can store that tree as one object of hundreds of MB (Harrison 22e: +500 MB, 2.5 s).
         * This handle never saves, so its in-memory catalog drops the tree. */
        if (!reader->locked) pdf_dict_del(ctx, pdf_dict_get(ctx, pdf_trailer(ctx, document), PDF_NAME(Root)), PDF_NAME(StructTreeRoot));
        int locked = reader->locked, sign = locked ? 0 : document_signed(ctx, document);
        int annotate = !locked && !sign && pdf_has_permission(ctx, document, FZ_PERMISSION_ANNOTATE);
        buffer = fz_new_buffer(ctx, 256);
        fz_append_printf(ctx, buffer, "{\"numPages\":%d,\"locked\":%s,\"signed\":%s,\"permissions\":{\"canCopy\":%s,\"canPrint\":%s,\"canAnnotate\":%s,\"canEdit\":false,\"canAssemble\":false,\"canFill\":false}}",
            locked ? 0 : pdf_count_pages(ctx, document), locked ? "true" : "false", sign ? "true" : "false",
            !locked && pdf_has_permission(ctx, document, FZ_PERMISSION_COPY) ? "true" : "false",
            !locked && pdf_has_permission(ctx, document, FZ_PERMISSION_PRINT) ? "true" : "false",
            annotate ? "true" : "false");
        *json = json_result(ctx, buffer);
        *out = reader; reader = NULL; status = 0;
    }
    fz_always(ctx) { fz_drop_buffer(ctx, buffer); }
    fz_catch(ctx) { fail_message(error, error_capacity, fz_caught_message(ctx)); }
    if (reader) { pdf_drop_document(ctx, reader->document); free(reader); }
    if (status) fz_drop_context(ctx);
    return status;
}

void folio_reader_close(folio_reader *reader)
{
    if (!reader) return;
    fz_context *ctx = reader->ctx;
    pdf_drop_document(ctx, reader->document);
    free(reader);
    fz_drop_context(ctx);
}

int folio_reader_page_info(folio_reader *reader, int32_t number, char **json, char *error, size_t error_capacity)
{
    if (!reader || !json) return -1;
    fz_context *ctx = reader->ctx;
    pdf_page *page = NULL;
    fz_link *links = NULL;
    fz_buffer *buffer = NULL;
    int status = -1;
    *json = NULL;
    fz_var(page); fz_var(links); fz_var(buffer); fz_var(status);
    fz_try(ctx) {
        page = reader_page(ctx, reader, number);
        int rotation = 0;
        fz_rect view = page_view(ctx, page->obj, &rotation);
        fz_matrix user = to_user(ctx, page);
        char label[256] = "";
        fz_page_label(ctx, (fz_page *)page, label, sizeof label);
        buffer = fz_new_buffer(ctx, 1024);
        fz_append_string(ctx, buffer, "{\"view\":"); json_rect(ctx, buffer, view);
        fz_append_printf(ctx, buffer, ",\"rotation\":%d,\"label\":", rotation);
        if (*label) json_string(ctx, buffer, label); else fz_append_printf(ctx, buffer, "\"%d\"", number);
        fz_append_string(ctx, buffer, ",\"links\":[");
        links = fz_load_links(ctx, (fz_page *)page);
        int first = 1, count = 0;
        for (fz_link *link = links; link && count < 5000; link = link->next) {
            if (!link->uri) continue;
            fz_rect rect = fz_transform_rect(link->rect, user);
            if (fz_is_external_link(ctx, link->uri)) {
                if (fz_strncasecmp(link->uri, "http:", 5) && fz_strncasecmp(link->uri, "https:", 6) &&
                    fz_strncasecmp(link->uri, "mailto:", 7) && fz_strncasecmp(link->uri, "tel:", 4)) continue;
                fz_append_string(ctx, buffer, first ? "{\"rect\":" : ",{\"rect\":"); json_rect(ctx, buffer, rect);
                fz_append_string(ctx, buffer, ",\"url\":"); json_string(ctx, buffer, link->uri);
                fz_append_byte(ctx, buffer, '}');
            } else {
                float x = NAN, y = NAN;
                fz_location location = fz_resolve_link(ctx, (fz_document *)reader->document, link->uri, &x, &y);
                int target = fz_page_number_from_location(ctx, (fz_document *)reader->document, location);
                if (target < 0 || target >= pdf_count_pages(ctx, reader->document)) continue;
                fz_append_string(ctx, buffer, first ? "{\"rect\":" : ",{\"rect\":"); json_rect(ctx, buffer, rect);
                fz_append_printf(ctx, buffer, ",\"page\":%d", target + 1);
                if (isfinite(x) && isfinite(y)) {
                    /* The destination point, from the target page's MuPDF space to its user space. */
                    pdf_obj *target_page = pdf_lookup_page_obj(ctx, reader->document, target);
                    fz_rect media; fz_matrix ctm;
                    pdf_page_obj_transform(ctx, target_page, &media, &ctm);
                    fz_point point = fz_transform_point(fz_make_point(x, y), fz_invert_matrix(ctm));
                    fz_append_string(ctx, buffer, ",\"left\":"); json_number(ctx, buffer, point.x);
                    fz_append_string(ctx, buffer, ",\"top\":"); json_number(ctx, buffer, point.y);
                }
                fz_append_byte(ctx, buffer, '}');
            }
            first = 0; ++count;
        }
        fz_append_string(ctx, buffer, "]}");
        *json = json_result(ctx, buffer); status = 0;
    }
    fz_always(ctx) { fz_drop_link(ctx, links); fz_drop_page(ctx, (fz_page *)page); fz_drop_buffer(ctx, buffer); }
    fz_catch(ctx) { fail_message(error, error_capacity, fz_caught_message(ctx)); }
    return status;
}

int folio_reader_text(folio_reader *reader, int32_t number, char **json, char *error, size_t error_capacity)
{
    if (!reader || !json) return -1;
    fz_context *ctx = reader->ctx;
    pdf_page *page = NULL;
    fz_stext_page *text = NULL;
    fz_buffer *buffer = NULL, *word = NULL;
    int status = -1;
    *json = NULL;
    fz_var(page); fz_var(text); fz_var(buffer); fz_var(word); fz_var(status);
    fz_try(ctx) {
        page = reader_page(ctx, reader, number);
        buffer = fz_new_buffer(ctx, 4096);
        word = fz_new_buffer(ctx, 64);
        fz_append_string(ctx, buffer, "{\"lines\":[");
        if (pdf_has_permission(ctx, reader->document, FZ_PERMISSION_COPY)) {
            fz_matrix user = to_user(ctx, page);
            text = fz_new_stext_page_from_page(ctx, (fz_page *)page, NULL);
            int first = 1, words = 0;
            for (fz_stext_block *block = text->first_block; block; block = block->next) {
                if (block->type != FZ_STEXT_BLOCK_TEXT) continue;
                for (fz_stext_line *line = block->u.t.first_line; line; line = line->next) {
                    fz_rect box = fz_empty_rect;
                    int pending = 0;
                    for (fz_stext_char *ch = line->first_char; ; ch = ch->next) {
                        int space = ch && (ch->c == ' ' || ch->c == '\t' || ch->c == 0xa0);
                        /* A word ends at the space after it, or at the end of the line. */
                        if (pending && (!ch || (space && ch->next && ch->next->c != ' '))) {
                            if (space) fz_append_rune(ctx, word, ' ');
                            fz_terminate_buffer(ctx, word);
                            fz_append_string(ctx, buffer, first ? "{\"text\":" : ",{\"text\":");
                            json_string(ctx, buffer, fz_string_from_buffer(ctx, word));
                            fz_append_string(ctx, buffer, ",\"bounds\":"); json_rect(ctx, buffer, fz_transform_rect(box, user));
                            fz_append_printf(ctx, buffer, ",\"hasEOL\":%s,\"direction\":\"ltr\"}", ch ? "false" : "true");
                            first = 0; pending = 0; box = fz_empty_rect; fz_clear_buffer(ctx, word);
                            if (++words > 200000) fz_throw(ctx, FZ_ERROR_LIMIT, "This page has too much text to read.");
                            if (ch) continue;
                        }
                        if (!ch) break;
                        if (space) continue;
                        fz_append_rune(ctx, word, ch->c);
                        box = fz_union_rect(box, fz_rect_from_quad(ch->quad));
                        pending = 1;
                    }
                }
            }
        }
        fz_append_string(ctx, buffer, "]}");
        *json = json_result(ctx, buffer); status = 0;
    }
    fz_always(ctx) { fz_drop_stext_page(ctx, text); fz_drop_page(ctx, (fz_page *)page); fz_drop_buffer(ctx, buffer); fz_drop_buffer(ctx, word); }
    fz_catch(ctx) { fail_message(error, error_capacity, fz_caught_message(ctx)); }
    return status;
}

static void outline_items(fz_context *ctx, fz_document *document, fz_outline *item, int depth, fz_buffer *buffer, int *count)
{
    for (; item && *count < 20000 && depth <= 64; item = item->next) {
        int page = item->uri ? fz_page_number_from_location(ctx, document, item->page) : -1;
        fz_append_string(ctx, buffer, *count ? ",{\"title\":" : "{\"title\":");
        json_string(ctx, buffer, item->title);
        if (page >= 0) fz_append_printf(ctx, buffer, ",\"page\":%d", page + 1);
        else fz_append_string(ctx, buffer, ",\"page\":null");
        fz_append_printf(ctx, buffer, ",\"depth\":%d}", depth);
        ++*count;
        outline_items(ctx, document, item->down, depth + 1, buffer, count);
    }
}

int folio_reader_outline(folio_reader *reader, char **json, char *error, size_t error_capacity)
{
    if (!reader || !json) return -1;
    fz_context *ctx = reader->ctx;
    fz_outline *outline = NULL;
    fz_buffer *buffer = NULL;
    int status = -1, count = 0;
    *json = NULL;
    fz_var(outline); fz_var(buffer); fz_var(status);
    fz_try(ctx) {
        if (reader->locked) fz_throw(ctx, FZ_ERROR_ARGUMENT, "The PDF password is missing or incorrect.");
        buffer = fz_new_buffer(ctx, 4096);
        fz_append_byte(ctx, buffer, '[');
        outline = fz_load_outline(ctx, (fz_document *)reader->document);
        outline_items(ctx, (fz_document *)reader->document, outline, 0, buffer, &count);
        fz_append_byte(ctx, buffer, ']');
        *json = json_result(ctx, buffer); status = 0;
    }
    fz_always(ctx) { fz_drop_outline(ctx, outline); fz_drop_buffer(ctx, buffer); }
    fz_catch(ctx) { fail_message(error, error_capacity, fz_caught_message(ctx)); }
    return status;
}

static int editable_annotation(fz_context *ctx, pdf_annot *annotation)
{
    enum pdf_annot_type type = pdf_annot_type(ctx, annotation);
    return (type == PDF_ANNOT_HIGHLIGHT || type == PDF_ANNOT_TEXT || type == PDF_ANNOT_INK) &&
        !(pdf_annot_flags(ctx, annotation) & (PDF_ANNOT_IS_INVISIBLE | PDF_ANNOT_IS_HIDDEN | PDF_ANNOT_IS_NO_VIEW));
}

int folio_reader_render(folio_reader *reader, int32_t number, int32_t width, int32_t height, int32_t rotation,
    int32_t full_width, int32_t full_height, int32_t x, int32_t y, int32_t skip_editable,
    unsigned char **png, size_t *png_length, char *error, size_t error_capacity)
{
    if (!reader || !png || !png_length) return -1;
    fz_context *ctx = reader->ctx;
    pdf_page *page = NULL;
    fz_pixmap *pixmap = NULL;
    fz_device *device = NULL;
    fz_buffer *buffer = NULL;
    int status = -1;
    *png = NULL; *png_length = 0;
    fz_var(page); fz_var(pixmap); fz_var(device); fz_var(buffer); fz_var(status);
    fz_try(ctx) {
        if (width <= 0 || height <= 0 || width > 4096 || height > 4096 || (int64_t)width * height > 4000000 ||
            rotation % 90 || full_width <= 0 || full_height <= 0 || full_width > 65536 || full_height > 65536 ||
            x < 0 || y < 0 || x >= full_width || y >= full_height)
            fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid page render request.");
        page = reader_page(ctx, reader, number);
        fz_rect view = page_view(ctx, page->obj, NULL);
        /* User space -> the viewer's rotated page (PDF.js PageViewport), then to the window. */
        int turn = ((rotation % 360) + 360) % 360;
        fz_matrix base = turn == 0 ? fz_make_matrix(1, 0, 0, -1, 0, 0) : turn == 90 ? fz_make_matrix(0, 1, 1, 0, 0, 0) :
            turn == 180 ? fz_make_matrix(-1, 0, 0, 1, 0, 0) : fz_make_matrix(0, -1, -1, 0, 0, 0);
        fz_rect turned = fz_transform_rect(view, base);
        base = fz_concat(base, fz_translate(-turned.x0, -turned.y0));
        float page_width = turned.x1 - turned.x0, page_height = turned.y1 - turned.y0;
        if (page_width <= 0 || page_height <= 0) fz_throw(ctx, FZ_ERROR_ARGUMENT, "The page has no size.");
        fz_matrix ctm = fz_concat(base, fz_scale(full_width / page_width, full_height / page_height));
        ctm = fz_concat(ctm, fz_translate(-x, -y));
        /* pdf_run_* start from MuPDF's page space; undo its transform first. */
        ctm = fz_concat(to_user(ctx, page), ctm);
        pixmap = fz_new_pixmap(ctx, fz_device_rgb(ctx), width, height, NULL, 0);
        fz_clear_pixmap_with_value(ctx, pixmap, 255);
        device = fz_new_draw_device(ctx, fz_identity, pixmap);
        pdf_run_page_contents(ctx, page, device, ctm, NULL);
        for (pdf_annot *annotation = pdf_first_annot(ctx, page); annotation; annotation = pdf_next_annot(ctx, annotation))
            if (!skip_editable || !editable_annotation(ctx, annotation)) pdf_run_annot(ctx, annotation, device, ctm, NULL);
        pdf_run_page_widgets(ctx, page, device, ctm, NULL);
        fz_close_device(ctx, device);
        buffer = fz_new_buffer_from_pixmap_as_png(ctx, pixmap, fz_default_color_params);
        unsigned char *data;
        size_t length = fz_buffer_storage(ctx, buffer, &data);
        *png = malloc(length);
        if (!*png) fz_throw(ctx, FZ_ERROR_SYSTEM, "Out of memory drawing the page.");
        memcpy(*png, data, length); *png_length = length; status = 0;
    }
    fz_always(ctx) {
        fz_drop_device(ctx, device); fz_drop_pixmap(ctx, pixmap); fz_drop_buffer(ctx, buffer);
        fz_drop_page(ctx, (fz_page *)page);
    }
    fz_catch(ctx) { fail_message(error, error_capacity, fz_caught_message(ctx)); }
    return status;
}

int folio_reader_annotations(folio_reader *reader, int32_t page, FolioSourceAnnotation **items, size_t *count,
    char *error, size_t error_capacity)
{
    if (!reader || !items || !count) return -1;
    fz_context *ctx = reader->ctx;
    int status = -1;
    *items = NULL; *count = 0;
    fz_var(status);
    fz_try(ctx) {
        if (reader->locked) fz_throw(ctx, FZ_ERROR_ARGUMENT, "The PDF password is missing or incorrect.");
        read_annotations(ctx, reader->document, page, items, count); status = 0;
    }
    fz_catch(ctx) { fail_message(error, error_capacity, fz_caught_message(ctx)); }
    return status;
}
