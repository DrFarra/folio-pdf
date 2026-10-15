"""Builds public/ocr/words.bin (gzip; not .gz, which servers send pre-decompressed): the Spanish and English word forms OCR checks words against
before it rewrites them as text (a word not found, read with any doubt, stays as scanned).

The forms come from Hunspell dictionaries, expanded here by their affix rules (prefixes,
suffixes, their cross products and one level of continuation classes):
  - Spanish: RLA-ES «es» (https://github.com/sbosio/rla-es), used under the GNU LGPL v3.
  - English: SCOWL en_US (http://wordlist.aspell.net), under its BSD-style licence.

  python scripts/build-wordlist.py <es.dic> <es.aff> <en_US.dic> <en_US.aff>
"""
import gzip
import re
import sys
import unicodedata
from pathlib import Path


def read_aff(path):
    text = Path(path).read_text(encoding='utf-8', errors='replace')
    flag_mode = 'char'
    rules = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        parts = lines[i].split()
        if parts and parts[0] == 'FLAG':
            flag_mode = 'long' if parts[1] == 'long' else 'num' if parts[1] == 'num' else 'char'
        if parts and parts[0] in ('PFX', 'SFX') and len(parts) >= 4 and parts[2] in ('Y', 'N'):
            kind, flag, cross, count = parts[0], parts[1], parts[2] == 'Y', int(parts[3])
            entries = []
            for line in lines[i + 1:i + 1 + count]:
                p = line.split()
                if len(p) < 5:
                    continue
                strip = '' if p[2] == '0' else p[2]
                add, _, cont = p[3].partition('/')
                add = '' if add == '0' else add
                condition = p[4]
                pattern = re.compile(('^' + condition) if kind == 'PFX' else (condition + '$')) if condition != '.' else None
                entries.append((strip, add, cont, pattern))
            rules[flag] = (kind, cross, entries)
            i += count
        i += 1
    return flag_mode, rules


def flags_of(text, mode):
    if mode == 'long':
        return [text[k:k + 2] for k in range(0, len(text), 2)]
    if mode == 'num':
        return [f for f in text.split(',') if f]
    return list(text)


def apply(word, rule):
    kind, _, entries = rule
    out = []
    for strip, add, cont, pattern in entries:
        if pattern and not pattern.search(word):
            continue
        if kind == 'SFX':
            if strip and not word.endswith(strip):
                continue
            base = word[:len(word) - len(strip)] if strip else word
            out.append((base + add, cont))
        else:
            if strip and not word.startswith(strip):
                continue
            base = word[len(strip):] if strip else word
            out.append((add + base, cont))
    return out


def expand(dic, aff):
    mode, rules = read_aff(aff)
    forms = set()
    for line in Path(dic).read_text(encoding='utf-8', errors='replace').splitlines()[1:]:
        line = line.split('\t')[0].strip()
        if not line:
            continue
        word, _, flagtext = line.partition('/')
        word = word.replace('\\/', '/')
        flags = flags_of(flagtext, mode)
        forms.add(word)
        suffixed = []
        for f in flags:
            rule = rules.get(f)
            if rule and rule[0] == 'SFX':
                for form, cont in apply(word, rule):
                    forms.add(form)
                    suffixed.append(form)
                    for c in flags_of(cont, mode):
                        more = rules.get(c)
                        if more and more[0] == 'SFX':
                            forms.update(f2 for f2, _ in apply(form, more))
        for f in flags:
            rule = rules.get(f)
            if rule and rule[0] == 'PFX':
                for form, _ in apply(word, rule):
                    forms.add(form)
                if rule[1]:
                    for s in suffixed:
                        forms.update(f2 for f2, _ in apply(s, rule))
    return forms


def key(word):
    # Lower case; accents kept (an accent misread is a misreading).
    return unicodedata.normalize('NFC', word).lower()


if __name__ == '__main__':
    es_dic, es_aff, en_dic, en_aff = sys.argv[1:5]
    words = {key(w) for w in expand(es_dic, es_aff) | expand(en_dic, en_aff)}
    words = sorted(w for w in words if w and re.fullmatch(r"[\w'-]+", w))
    out = Path(__file__).resolve().parent.parent / 'public' / 'ocr' / 'words.bin'
    with gzip.open(out, 'wb', compresslevel=9) as f:
        f.write(chr(10).join(words).encode('utf-8'))
    print(len(words), 'words,', out.stat().st_size, 'bytes')
