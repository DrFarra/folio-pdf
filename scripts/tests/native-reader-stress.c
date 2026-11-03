/* Exercises every call Android's native PDF reader makes on one PDF (scripts/tests/native-reader-stress.sh). */
#include "FolioMuPDF.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
/* Exercises every reader call the app makes on one PDF; any crash or hang is caught by the caller. */
int main(int argc, char **argv) {
  char err[2048]; folio_reader *r; char *j;
  if (folio_reader_open(argv[1], "", &r, &j, err, sizeof err)) { printf("open-error %s\n", err); return 0; }
  int pages = 0; sscanf(strstr(j, "\"numPages\":") + 11, "%d", &pages); int locked = strstr(j, "\"locked\":true") != NULL; folio_reader_free(j);
  if (locked) { folio_reader_close(r); if (folio_reader_open(argv[1], "test", &r, &j, err, sizeof err)) { printf("locked\n"); return 0; } folio_reader_free(j); }
  if (!folio_reader_outline(r, &j, err, sizeof err)) folio_reader_free(j);
  int step = pages > 120 ? pages / 120 : 1, errors = 0, done = 0;
  for (int p = 1; p <= pages; p += step) {
    if (folio_reader_page_info(r, p, &j, err, sizeof err)) errors++; else folio_reader_free(j);
    if (folio_reader_text(r, p, &j, err, sizeof err)) errors++; else folio_reader_free(j);
    unsigned char *png; size_t n;
    if (folio_reader_render(r, p, 600, 800, 90 * (p % 4), 1200, 1600, 300, 400, 1, &png, &n, err, sizeof err)) errors++; else folio_reader_free(png);
    FolioSourceAnnotation *a; size_t c; if (folio_reader_annotations(r, p, &a, &c, err, sizeof err)) errors++; else folio_pdf_free_annotations(a, c);
    done++;
  }
  folio_reader_close(r);
  struct rusage u; getrusage(RUSAGE_SELF, &u);
  printf("ok pages=%d tested=%d errors=%d peak=%ldMB\n", pages, done, errors, u.ru_maxrss / 1024);
  return 0;
}
