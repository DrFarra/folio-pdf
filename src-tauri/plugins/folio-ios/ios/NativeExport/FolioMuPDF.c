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
    }
    free(items);
}

int folio_pdf_read_annotations(const char *path, const char *password, int32_t page,
    FolioSourceAnnotation **out_items, size_t *out_count, char *error, size_t error_capacity)
{
    fz_context *ctx = fz_new_context(NULL, NULL, 32 * 1024 * 1024);
    pdf_document *document = NULL;
    FolioSourceAnnotation *items = NULL;
    size_t count = 0;
    int status = -1;
    if (!ctx) { fail_message(error, error_capacity, "Out of memory opening PDF metadata."); return -1; }
    if (!out_items || !out_count) { fz_drop_context(ctx); return -1; }
    *out_items = NULL; *out_count = 0;
    fz_var(document); fz_var(items); fz_var(count); fz_var(status);
    fz_try(ctx) {
        document = open_pdf(ctx, path, password);
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
            int kind = !strcmp(type, "Highlight") ? 1 : !strcmp(type, "Text") ? 2 : 0;
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
        }
        *out_items = items; *out_count = count; items = NULL; status = 0;
    }
    fz_always(ctx) { folio_pdf_free_annotations(items, count); pdf_drop_document(ctx, document); }
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
            if (strcmp(type, "Highlight") && strcmp(type, "Text")) fz_throw(ctx, FZ_ERROR_ARGUMENT, "This source annotation cannot be edited in Folio.");
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
            if ((item->kind != 1 && item->kind != 2) || !item->name || !item->contents || !item->author ||
                !isfinite(item->opacity) || item->opacity < 0 || item->opacity > 1 || item->quad_count > 131072)
                fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid PDF annotation payload.");
            for (int n = 0; n < 4; ++n) if (!isfinite(item->rect[n])) fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid PDF annotation coordinates.");
            if (item->rect[2] <= item->rect[0] || item->rect[3] <= item->rect[1]) fz_throw(ctx, FZ_ERROR_ARGUMENT, "Invalid PDF annotation bounds.");
            pdf_annot *annotation = pdf_create_annot_raw(ctx, page, item->kind == 1 ? PDF_ANNOT_HIGHLIGHT : PDF_ANNOT_TEXT);
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
