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
    int32_t kind; /* 1 Highlight, 2 Text */
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

#ifdef __cplusplus
}
#endif
#endif
