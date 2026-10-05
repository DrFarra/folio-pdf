"""Remove incremental ZIP padding without changing entry contents or compression."""
import re
import sys
import zipfile

source, destination = sys.argv[1:]
with zipfile.ZipFile(source) as original, zipfile.ZipFile(destination, "w") as compact:
    for entry in original.infolist():
        # The archive is signed again after zipalign. Never retain stale signatures.
        if re.fullmatch(r"META-INF/[^/]+\.(SF|RSA|DSA|EC|MF)", entry.filename, re.I):
            continue
        fresh = zipfile.ZipInfo(entry.filename, entry.date_time)
        fresh.compress_type = entry.compress_type
        fresh.external_attr = entry.external_attr
        compact.writestr(fresh, original.read(entry))
with zipfile.ZipFile(source) as original, zipfile.ZipFile(destination) as compact:
    for entry in compact.infolist():
        assert original.read(entry.filename) == compact.read(entry), entry.filename
