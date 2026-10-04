// Expose the shared C ABI to SwiftPM without compiling the MuPDF implementation
// twice. The implementation is built with its SDK and linked by Cargo.
#include "FolioMuPDF.h"
