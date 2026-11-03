#ifndef FOLIO_MUPDF_H
#define FOLIO_MUPDF_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Only page-sized metadata crosses this ABI. Coordinates are unrotated PDF
 * user space (y up); index refers to the original raw /Annots array. */
typedef struct {
    int32_t index;
    int32_t kind; /* 1 Highlight, 2 Text, 3 Ink */
    int32_t flags;
    float rect[4];
    float color[3];
    float opacity;
    int64_t modified_seconds;
    char *name;
    char *contents;
    char *author;
    size_t quad_count;
    float *quads; /* quad_count * 8 floats, UL UR LL LR */
    float stroke_width;
    size_t path_count;
    int32_t *path_sizes; /* number of floats (x,y pairs) in each path */
    float *ink_points;
} FolioSourceAnnotation;

typedef struct {
    int32_t page; /* one based */
    int32_t kind;
    float rect[4];
    float color[3];
    float opacity;
    int64_t modified_seconds;
    const char *name;
    const char *contents;
    const char *author;
    size_t quad_count;
    const float *quads;
    float stroke_width;
    size_t path_count;
    const int32_t *path_sizes;
    const float *ink_points;
} FolioOverlay;

typedef struct { int32_t page; int32_t index; } FolioRemoval;

/* Return 0 on success, -1 with a bounded UTF-8 error. MuPDF's exception
 * longjmp never escapes these C functions into Swift or Rust. */
int folio_pdf_read_annotations(const char *path, const char *password,
    int32_t page, FolioSourceAnnotation **items, size_t *count,
    char *error, size_t error_capacity);
void folio_pdf_free_annotations(FolioSourceAnnotation *items, size_t count);
int folio_pdf_export(const char *source, const char *output, const char *password,
    const FolioOverlay *overlays, size_t overlay_count,
    const FolioRemoval *removals, size_t removal_count,
    char *error, size_t error_capacity);
const char *folio_pdf_engine_version(void);

/* File-backed reader (Android's large-PDF mode). MuPDF reads the file on
 * demand; only page-sized JSON and PNG cross this ABI. A reader must not be
 * used from two threads at once. JSON coordinates are unrotated PDF user space. */
typedef struct folio_reader folio_reader;
/* *json: {"numPages","locked","signed","permissions":{canCopy,canPrint,canAnnotate}}.
 * A locked PDF still returns a reader, with locked true and numPages 0. */
int folio_reader_open(const char *path, const char *password, folio_reader **reader, char **json,
    char *error, size_t error_capacity);
void folio_reader_close(folio_reader *reader);
/* {"view","rotation","label","links":[{rect,url}|{rect,page,left?,top?}]} */
int folio_reader_page_info(folio_reader *reader, int32_t page, char **json, char *error, size_t error_capacity);
/* {"lines":[{text,bounds,hasEOL,direction}]}, one entry per word as PDFKit's reader does. */
int folio_reader_text(folio_reader *reader, int32_t page, char **json, char *error, size_t error_capacity);
/* [{title,page|null,depth}] */
int folio_reader_outline(folio_reader *reader, char **json, char *error, size_t error_capacity);
/* A PNG of the page turned by `rotation`, scaled to full_width x full_height and cut
 * to the width x height window at (x, y). With skip_editable, highlight, note and ink
 * annotations are left to Folio's overlay. */
int folio_reader_render(folio_reader *reader, int32_t page, int32_t width, int32_t height, int32_t rotation,
    int32_t full_width, int32_t full_height, int32_t x, int32_t y, int32_t skip_editable,
    unsigned char **png, size_t *png_length, char *error, size_t error_capacity);
int folio_reader_annotations(folio_reader *reader, int32_t page, FolioSourceAnnotation **items, size_t *count,
    char *error, size_t error_capacity);
void folio_reader_free(void *pointer);

#ifdef __cplusplus
}
#endif
#endif
