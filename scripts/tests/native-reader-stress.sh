#!/usr/bin/env bash
# Runs Android's native PDF reader (FolioMuPDF.c with Folio's MuPDF patches) over the test
# corpus and damaged copies of it (cut short, random bytes changed) under AddressSanitizer.
# Fails on any crash, hang or memory error; a damaged PDF may be refused, never crash.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$root/test-results/native-reader-stress
mkdir -p "$work/damaged"
archive=$root/test-results/mupdf-1.28.1-source.tar.gz
[ -f "$archive" ] || curl --fail --location --retry 3 -o "$archive" https://mupdf.com/downloads/archive/mupdf-1.28.1-source.tar.gz
echo 'dc94c60b2537e2ac9a2d379dd3801545f84a3a302d15c9da358362a1270707c3  '"$archive" | sha256sum -c -
rm -rf "$work/mupdf" && mkdir -p "$work/mupdf" && tar -xzf "$archive" -C "$work/mupdf" --strip-components=1
for patch in "$root"/scripts/mupdf-patches/*.patch; do patch -d "$work/mupdf" -p1 --forward -i "$patch"; done
make -C "$work/mupdf" -j"$(nproc)" build=release HAVE_X11=no HAVE_GLUT=no HAVE_GLFW=no html=no xps=no svg=no extract=no barcode=no tesseract=no mujs=no libs > "$work/mupdf-build.log"
native=$root/src-tauri/plugins/folio-ios/ios/NativeExport
cc -O1 -g -fsanitize=address,undefined -I"$work/mupdf/include" -I"$native/include" "$native/FolioMuPDF.c" \
  "$root/scripts/tests/native-reader-stress.c" -o "$work/stress" \
  "$work/mupdf/build/release/libmupdf.a" "$work/mupdf/build/release/libmupdf-third.a" -lm -lpthread
find "$root/.fixtures" -name '*.pdf' > "$work/files.txt"
python3 -I - "$work" <<'PY'
import os, random, sys
work = sys.argv[1]; random.seed(7)
for f in open(os.path.join(work, 'files.txt')).read().split():
    data = open(f, 'rb').read(); base = os.path.basename(f)[:-4]
    variants = {'cut50': data[: len(data) // 2], 'cut90': data[: len(data) * 9 // 10]}
    for k in range(3):
        b = bytearray(data)
        for _ in range(200): b[random.randrange(len(b))] = random.randrange(256)
        variants[f'flip{k}'] = bytes(b)
    for name, blob in variants.items(): open(os.path.join(work, 'damaged', f'{base}-{name}.pdf'), 'wb').write(blob)
PY
find "$work/damaged" -name '*.pdf' >> "$work/files.txt"
failed=0 opened=0
while read -r pdf; do
  if output=$(ASAN_OPTIONS=detect_leaks=1 UBSAN_OPTIONS=halt_on_error=1 timeout 300 "$work/stress" "$pdf" 2>&1); then
    grep -q '^ok ' <<< "$output" && opened=$((opened + 1))
  else
    code=$?; failed=$((failed + 1)); echo "::error::$(basename "$pdf"): exit $code"; tail -40 <<< "$output"
  fi
done < "$work/files.txt"
echo "$(wc -l < "$work/files.txt") PDFs, $opened opened and read, $failed crashed or hung."
[ "$failed" = 0 ]
