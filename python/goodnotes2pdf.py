#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
goodnotes2pdf.py - convertit un fichier Goodnotes (.goodnotes) en PDF vectoriel,
directement sur l'ordinateur (l'export PDF de la tablette est lent).

Bibliothèque standard uniquement (Pillow est utilisé si présent, seulement pour
les images qui ne sont pas des JPEG).

    python goodnotes2pdf.py cours.goodnotes                # -> cours.pdf
    python goodnotes2pdf.py cours.goodnotes -o sortie.pdf
    python goodnotes2pdf.py cours.goodnotes -f             # écrase cours.pdf s'il existe
    python goodnotes2pdf.py *.goodnotes                    # plusieurs fichiers

Format (rétro-ingénierie, Goodnotes 6) :
  - le .goodnotes est un zip : notes/<uuid> (une page = un fichier), attachments/
    (fonds de page en PDF, images), index.*.pb (ordre des pages, modèles...).
  - un fichier de page est une suite d'enregistrements protobuf préfixés par leur
    longueur : (en-tête, charge utile) pour chaque objet (trait, forme, image).
  - la géométrie d'un trait est compressée en LZ4 (conteneur Apple "bv41") puis
    décrite par un petit format binaire "tpl" : largeur, point de départ et
    segments de Bézier quadratiques.
  - les coordonnées sont en "unités Goodnotes" ; le PDF exporté les ramène à la
    taille du fond de page (facteur 6/11 avec les modèles standard).
"""
import argparse
import math
import os
import re
import struct
import sys
import uuid
import zipfile
import zlib
from collections import Counter


# --------------------------------------------------------------------------- #
# Protobuf minimal
# --------------------------------------------------------------------------- #

def _varint(buf, i):
    r = s = 0
    while True:
        b = buf[i]
        i += 1
        r |= (b & 0x7F) << s
        if not b & 0x80:
            return r, i
        s += 7


def parse_msg(buf):
    """Message protobuf -> {champ: [valeurs]} (int, ou bytes pour longueur/fixed)."""
    out = {}
    i, n = 0, len(buf)
    try:
        while i < n:
            key, i = _varint(buf, i)
            f, w = key >> 3, key & 7
            if w == 0:
                v, i = _varint(buf, i)
            elif w == 2:
                ln, i = _varint(buf, i)
                if i + ln > n:
                    raise ValueError("message tronqué")
                v = buf[i:i + ln]
                i += ln
            elif w == 5:
                v = buf[i:i + 4]
                i += 4
            elif w == 1:
                v = buf[i:i + 8]
                i += 8
            else:
                raise ValueError("type de fil %d inconnu" % w)
            out.setdefault(f, []).append(v)
    except IndexError:
        raise ValueError("message tronqué")
    return out


def records(buf):
    """Suite d'enregistrements préfixés par leur longueur (varint)."""
    i = 0
    while i < len(buf):
        ln, i = _varint(buf, i)
        yield buf[i:i + ln]
        i += ln


def f32(b):
    return struct.unpack("<f", b)[0]


def point(b):
    m = parse_msg(b)
    return (f32(m[1][0]) if 1 in m else 0.0, f32(m[2][0]) if 2 in m else 0.0)


_UUID_RE = re.compile(rb"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")


def is_uuid(b):
    return len(b) == 36 and _UUID_RE.fullmatch(b) is not None


# --------------------------------------------------------------------------- #
# LZ4 / conteneur Apple "bv41"
# --------------------------------------------------------------------------- #

def _lz4_block(src):
    out = bytearray()
    i, n = 0, len(src)
    while i < n:
        tok = src[i]
        i += 1
        lit = tok >> 4
        if lit == 15:
            while True:
                b = src[i]
                i += 1
                lit += b
                if b != 255:
                    break
        out += src[i:i + lit]
        i += lit
        if i >= n:
            break
        off = src[i] | (src[i + 1] << 8)
        i += 2
        ml = tok & 15
        if ml == 15:
            while True:
                b = src[i]
                i += 1
                ml += b
                if b != 255:
                    break
        ml += 4
        start = len(out) - off
        if off >= ml:
            out += out[start:start + ml]
        else:
            for k in range(ml):
                out.append(out[start + k])
    return bytes(out)


def bv4_decompress(data):
    out = bytearray()
    i = 0
    while i < len(data):
        magic = data[i:i + 4]
        if magic == b"bv41":
            _, packed = struct.unpack_from("<II", data, i + 4)
            out += _lz4_block(data[i + 12:i + 12 + packed])
            i += 12 + packed
        elif magic == b"bv4-":
            (size,) = struct.unpack_from("<I", data, i + 4)
            out += data[i + 8:i + 8 + size]
            i += 8 + size
        elif magic == b"bv4$":
            break
        else:
            raise ValueError("bloc bv4 inconnu")
    return bytes(out)


# --------------------------------------------------------------------------- #
# Géométrie d'un trait ("tpl")
# --------------------------------------------------------------------------- #

STROKE_DESC = b"vuA(v)A(S(uu))A(S(uuuu))vA(f)"


class Unsupported(Exception):
    pass


def decode_stroke(raw):
    """-> (largeur, opérations) ; opérations = [('m', x, y), ('q', cx, cy, x, y), ...]."""
    d = bv4_decompress(raw) if raw[:3] == b"bv4" else raw
    if d[:4] != b"tpl\0":
        raise Unsupported("géométrie inconnue")
    end = d.index(b"\0", 8)
    if d[8:end] != STROKE_DESC:
        raise Unsupported("format de trait inconnu : %r" % d[8:end])
    o = end + 1
    version, width, n = struct.unpack_from("<HfI", d, o)
    o += 10
    if version != 2:
        raise Unsupported("version de trait %d" % version)
    kinds = struct.unpack_from("<%dH" % n, d, o)
    o += 2 * n
    (n,) = struct.unpack_from("<I", d, o)
    o += 4
    starts = struct.unpack_from("<%df" % (2 * n), d, o)
    o += 8 * n
    (n,) = struct.unpack_from("<I", d, o)
    o += 4
    segs = struct.unpack_from("<%df" % (4 * n), d, o)
    ops = []
    si = qi = 0
    for k in kinds:
        if k == 0:
            ops.append(("m", starts[2 * si], starts[2 * si + 1]))
            si += 1
        elif qi < n:
            ops.append(("q",) + segs[4 * qi:4 * qi + 4])
            qi += 1
    return width, ops


def path_to_pdf(ops, fmt):
    """Opérations -> texte PDF (les quadratiques deviennent des cubiques)."""
    out = []
    cx0 = cy0 = None
    for op in ops:
        t = op[0]
        if t == "m":
            cx0, cy0 = op[1], op[2]
            out.append("%s %s m" % (fmt(cx0), fmt(cy0)))
        elif t == "l":
            cx0, cy0 = op[1], op[2]
            out.append("%s %s l" % (fmt(cx0), fmt(cy0)))
        elif t == "q":
            qx, qy, x, y = op[1:]
            out.append("%s %s %s %s %s %s c" % (
                fmt(cx0 + 2 / 3 * (qx - cx0)), fmt(cy0 + 2 / 3 * (qy - cy0)),
                fmt(x + 2 / 3 * (qx - x)), fmt(y + 2 / 3 * (qy - y)), fmt(x), fmt(y)))
            cx0, cy0 = x, y
        elif t == "c":
            out.append(" ".join(fmt(v) for v in op[1:]) + " c")
        elif t == "h":
            out.append("h")
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# Formes (rectangle, polygone, ellipse)
# --------------------------------------------------------------------------- #

def _rot(cx, cy, dx, dy, ang):
    c, s = math.cos(ang), math.sin(ang)
    return (cx + dx * c - dy * s, cy + dx * s + dy * c)


def shape_path(f4):
    """Géométrie d'une forme : champ 1 polygone/ligne, 2 courbe (3 points), 3 rectangle, 4 ellipse."""
    m = parse_msg(f4)
    if 1 in m:  # polygone ou ligne ; fermé si le dernier point reprend le premier
        pts = [point(p) for p in parse_msg(m[1][0]).get(1, [])]
        if not pts:
            return []
        ops = [("m",) + pts[0]] + [("l",) + p for p in pts[1:]]
        if len(pts) > 2 and pts[-1] == pts[0]:
            ops.append(("h",))
        return ops
    if 2 in m:  # courbe : départ, point de contrôle, arrivée
        g = parse_msg(m[2][0])
        p0, p1, p2 = point(g[1][0]), point(g[2][0]), point(g[3][0])
        return [("m",) + p0, ("q",) + p1 + p2]
    if 3 in m:  # rectangle : centre, taille[, angle]
        g = parse_msg(m[3][0])
        cx, cy = point(g[1][0])
        w, h = point(g[2][0])
        ang = f32(g[3][0]) if 3 in g else 0.0
        pts = [_rot(cx, cy, sx * w / 2, sy * h / 2, ang)
               for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        return [("m",) + pts[0]] + [("l",) + p for p in pts[1:]] + [("h",)]
    if 4 in m:  # ellipse : centre, rayons[, angle]
        g = parse_msg(m[4][0])
        cx, cy = point(g[1][0])
        rx, ry = point(g[2][0])
        ang = f32(g[3][0]) if 3 in g else 0.0
        k = 0.5522847498
        loc = [(rx, 0), (rx, ry * k), (rx * k, ry), (0, ry), (-rx * k, ry), (-rx, ry * k),
               (-rx, 0), (-rx, -ry * k), (-rx * k, -ry), (0, -ry), (rx * k, -ry), (rx, -ry * k), (rx, 0)]
        pts = [_rot(cx, cy, dx, dy, ang) for dx, dy in loc]
        ops = [("m",) + pts[0]]
        for i in range(1, 13, 3):
            ops.append(("c",) + pts[i] + pts[i + 1] + pts[i + 2])
        ops.append(("h",))
        return ops
    return []


# --------------------------------------------------------------------------- #
# Lecture du document .goodnotes
# --------------------------------------------------------------------------- #

def _rgba(b, default=(0.0, 0.0, 0.0, 1.0)):
    if not b:
        return default
    m = parse_msg(b)
    return tuple(f32(m[i][0]) if i in m else (1.0 if i == 4 else 0.0) for i in (1, 2, 3, 4))


class Item:
    """Un objet dessiné sur une page (trait, forme ou image)."""

    def __init__(self, kind, clock, order):
        self.kind = kind
        self.clock = clock
        self.order = order
        self.ops = []
        self.width = 1.0
        self.color = (0.0, 0.0, 0.0, 1.0)
        self.fill = None       # remplissage RGBA des formes
        self.blend = False
        self.tx = self.ty = 0.0
        self.image = None      # uuid de la pièce jointe
        self.rect = None       # (x, y, w, h, angle) pour les images


# Numéro du champ qui enveloppe la charge utile d'un objet, selon son type.
KIND_STROKE, KIND_IMAGE, KIND_SHAPE = 7, 1, 9


def read_page(data, warn):
    """Fichier de page -> liste d'Item triée dans l'ordre de dessin."""
    objs = []
    hdr = {}
    for rec in records(data):
        m = parse_msg(rec)
        if 1 in m and is_uuid(m[1][0]):   # en-tête d'un objet
            hdr = m
        else:                              # charge utile : un seul champ = le type
            for kind, vals in m.items():
                objs.append((hdr, kind, parse_msg(vals[0])))
            hdr = {}

    items = []
    skipped = Counter()
    for order, (hdr, kind, p) in enumerate(objs):
        if hdr.get(3, [0])[0] == 1 or p.get(14, [0])[0] == 1:
            continue  # objet supprimé
        clock = hdr.get(9, [0])[0]
        try:
            if kind == KIND_STROKE:
                it = Item("stroke", clock, order)
                it.width, it.ops = decode_stroke(p[2][0])
                if not it.ops and p.get(9, [b""])[0]:
                    # trait "redressé" (ligne, rectangle...) : géométrie dans le champ 9
                    hint = parse_msg(p[9][0])
                    it.ops = shape_path(p[9][0])
                    if 15 in hint:
                        it.width = f32(hint[15][0])
                if not it.ops:
                    continue
                if len(it.ops) == 1:  # simple point : un segment de longueur nulle
                    it.ops.append(("l", it.ops[0][1], it.ops[0][2]))
                it.color = _rgba(p.get(4, [b""])[0])
                it.blend = p.get(5, [0])[0] == 1  # surligneur
            elif kind == KIND_SHAPE:
                # forme : remplissage seulement, le contour est un trait à part
                it = Item("shape", clock, order)
                it.ops = shape_path(p[4][0])
                it.fill = _rgba(p.get(7, [b""])[0], None)
                if not it.ops or not it.fill:
                    continue
            elif kind == KIND_IMAGE:
                it = Item("image", clock, order)
                it.image = p[4][0].decode().upper()
                ox, oy = point(parse_msg(p[2][0])[1][0])
                w, h = point(parse_msg(p[2][0])[2][0])
                ang = 0.0
                if 3 in p:
                    g = parse_msg(p[3][0])
                    if 3 in g:
                        ang = f32(g[3][0])
                        (ox, oy), (w, h) = point(g[1][0]), point(g[2][0])
                        ox, oy = ox - w / 2, oy - h / 2
                it.rect = (ox, oy, w, h, ang)
            else:
                skipped["objet de type inconnu (%d)" % kind] += 1
                continue
            if kind != KIND_IMAGE and isinstance(p.get(6, [0])[0], bytes) and p[6][0]:
                t = parse_msg(p[6][0])   # translation appliquée à l'objet
                it.tx = f32(t[1][0]) if 1 in t else 0.0
                it.ty = f32(t[2][0]) if 2 in t else 0.0
            items.append(it)
        except (Unsupported, ValueError, struct.error, KeyError, IndexError) as e:
            skipped[str(e) or "objet illisible"] += 1
    for reason, n in skipped.items():
        warn("%d objet(s) ignoré(s) : %s" % (n, reason))
    items.sort(key=lambda it: (it.clock, it.order))
    return items


def _uuid_plus_one(u):
    return str(uuid.UUID(int=(uuid.UUID(u).int + 1) & ((1 << 128) - 1))).upper()


def read_events(data, warn):
    """index.events.pb -> (pages, modèles), chacun indexé par identifiant."""
    pages, templates = {}, {}
    for idx, rec in enumerate(records(data)):
        try:
            m = parse_msg(rec)
            for f, vals in m.items():
                if f == 1 or not isinstance(vals[0], bytes):
                    continue
                if f == 54:      # page
                    p = parse_msg(vals[0])
                    pid = p[2][0].decode().upper()
                    tpl = None
                    if 3 in p:
                        tpl = parse_msg(p[3][0])[1][0].decode().upper()
                    cand = (p.get(14, [0])[0], idx, tpl)
                    if pid not in pages or cand[:2] > pages[pid][:2]:
                        pages[pid] = cand
                elif f == 2:     # modèle de page
                    t = parse_msg(vals[0])
                    tid = t[2][0].decode().upper()
                    att = t[4][0].decode().upper() if 4 in t else None
                    size = point(t[8][0]) if 8 in t else None
                    cand = (t.get(16, [0])[0], idx, att, size)
                    if tid not in templates or cand[:2] > templates[tid][:2]:
                        templates[tid] = cand
        except (ValueError, KeyError, IndexError, UnicodeDecodeError):
            continue
    return pages, templates


class Document:
    """Contenu d'un .goodnotes : liste de pages (uuid de note, attachement, taille)."""

    def __init__(self, path, warn):
        self.zip = zipfile.ZipFile(path)
        self.names = set(self.zip.namelist())
        self.warn = warn
        order = []
        for r in records(self.zip.read("index.notes.pb")):
            m = parse_msg(r)
            order.append((m[1][0].decode().upper(), m[2][0].decode()))
        pages, templates = {}, {}
        if "index.events.pb" in self.names:
            pages, templates = read_events(self.zip.read("index.events.pb"), warn)
        by_note = {}
        for pid, (_, _, tpl) in pages.items():
            try:
                by_note[_uuid_plus_one(pid)] = tpl
            except ValueError:
                pass
        self.pages = []
        for note_id, path_in_zip in order:
            attach = size = None
            tpl = by_note.get(note_id)
            if tpl and tpl in templates:
                _, _, attach, size = templates[tpl]
            self.pages.append((path_in_zip, attach, size))

    def read(self, name):
        return self.zip.read(name)

    def has(self, name):
        return name in self.names


# --------------------------------------------------------------------------- #
# Lecture minimale d'un PDF (fonds de page) pour l'intégrer comme Form XObject
# --------------------------------------------------------------------------- #

_WS = b" \t\r\n\x0c\x00"
_DELIM = b"()<>[]{}/%"


def _skip_ws(d, i):
    while i < len(d) and (d[i] in _WS):
        i += 1
    return i


def _skip_value(d, i):
    """Index de fin de la valeur PDF qui commence en i."""
    if i >= len(d):
        raise ValueError("PDF tronqué")
    c = d[i:i + 1]
    if d[i:i + 2] == b"<<":
        i += 2
        while True:
            i = _skip_ws(d, i)
            if d[i:i + 2] == b">>":
                return i + 2
            i = _skip_value(d, i)
    if c == b"[":
        i += 1
        while True:
            i = _skip_ws(d, i)
            if d[i:i + 1] == b"]":
                return i + 1
            i = _skip_value(d, i)
    if c == b"(":
        depth = 0
        while True:
            if i >= len(d):
                raise ValueError("PDF tronqué")
            ch = d[i:i + 1]
            if ch == b"\\":
                i += 2
                continue
            if ch == b"(":
                depth += 1
            elif ch == b")":
                depth -= 1
                if depth == 0:
                    return i + 1
            i += 1
    if c == b"<":
        return d.index(b">", i) + 1
    start = i
    if c == b"/":
        i += 1
    while i < len(d) and d[i] not in _WS and d[i] not in _DELIM:
        i += 1
    return i if i > start else start + 1   # toujours progresser


def _dict_items(text):
    """Texte d'un dictionnaire PDF -> {b'/Cle': texte brut de la valeur}."""
    items = {}
    i = _skip_ws(text, 0)
    if text[i:i + 2] != b"<<":
        return items
    i += 2
    while True:
        i = _skip_ws(text, i)
        if text[i:i + 2] == b">>" or i >= len(text):
            return items
        j = _skip_value(text, i)
        key = text[i:j]
        i = _skip_ws(text, j)
        m = re.compile(rb"\d+\s+\d+\s+R").match(text, i)
        j = m.end() if m else _skip_value(text, i)
        items[key] = text[i:j]
        i = j


_OBJ_RE = re.compile(rb"(?<![\d.])(\d+)\s+(\d+)\s+obj\b")
_REF_RE = re.compile(rb"(\d+)\s+(\d+)\s+R\b")


class PdfSource:
    """Lecture (simplifiée) d'un PDF classique pour en extraire une page."""

    def __init__(self, data):
        if b"/Encrypt" in data[-2048:]:
            raise Unsupported("PDF chiffré")
        self.objs = {}
        pos = 0
        while True:
            m = _OBJ_RE.search(data, pos)
            if not m:
                break
            num = int(m.group(1))
            i = _skip_ws(data, m.end())
            end = _skip_value(data, i)
            value = data[i:end]
            stream = None
            j = _skip_ws(data, end)
            if data[j:j + 6] == b"stream":
                k = j + 6
                if data[k:k + 2] == b"\r\n":
                    k += 2
                elif data[k:k + 1] in (b"\n", b"\r"):
                    k += 1
                ln = re.search(rb"/Length\s+(\d+)(?!\s+\d+\s+R)", value)
                e = None
                if ln:
                    cand = k + int(ln.group(1))
                    if data[_skip_ws(data, cand):][:9] == b"endstream":
                        e = cand
                if e is None:
                    e = data.index(b"endstream", k)
                    if data[e - 2:e] == b"\r\n":
                        e -= 2
                    elif data[e - 1:e] in (b"\n", b"\r"):
                        e -= 1
                stream = data[k:e]
                end = data.index(b"endstream", e) + 9
            self.objs[num] = (value, stream)
            pos = end
        self._expand_object_streams()

    def _expand_object_streams(self):
        """Les PDF récents rangent la plupart des objets dans des flux compressés (/ObjStm)."""
        for num, (value, stream) in list(self.objs.items()):
            if stream is None or not re.search(rb"/Type\s*/ObjStm", value):
                continue
            d = _dict_items(value)
            try:
                count, first = int(d[b"/N"]), int(d[b"/First"])
                data = zlib.decompress(stream) if b"FlateDecode" in d.get(b"/Filter", b"") else stream
                head = data[:first].split()
                pairs = [(int(head[2 * i]), int(head[2 * i + 1])) for i in range(count)]
            except (KeyError, ValueError, IndexError, zlib.error):
                continue
            for i, (onum, off) in enumerate(pairs):
                end = pairs[i + 1][1] if i + 1 < count else len(data) - first
                self.objs.setdefault(onum, (data[first + off:first + end].strip(), None))

    def _resolve(self, raw):
        m = _REF_RE.fullmatch(raw.strip())
        return self.objs[int(m.group(1))][0] if m else raw

    def page(self, index=0):
        """-> (MediaBox [x0,y0,x1,y1], Resources brut, Contents [num,...])."""
        cat = next((v for v, _ in self.objs.values()
                    if re.search(rb"/Type\s*/Catalog\b", v)), None)
        if cat is None:
            raise Unsupported("catalogue PDF introuvable")
        leaves = []

        def walk(raw, inherited):
            d = _dict_items(self._resolve(raw))
            inh = dict(inherited)
            for k in (b"/Resources", b"/MediaBox"):
                if k in d:
                    inh[k] = d[k]
            if b"/Kids" in d:
                for kid in _REF_RE.finditer(self._resolve(d[b"/Kids"])):
                    walk(kid.group(0), inh)
            else:
                leaves.append((d, inh))

        walk(_dict_items(cat)[b"/Pages"], {})
        d, inh = leaves[index]
        box = [float(x) for x in self._resolve(inh[b"/MediaBox"]).strip(b"[] \r\n").split()]
        contents = [int(m.group(1)) for m in _REF_RE.finditer(d.get(b"/Contents", b""))]
        return box, inh.get(b"/Resources", b"<< >>"), contents

    def content_bytes(self, nums):
        out = []
        for n in nums:
            value, stream = self.objs[n]
            filt = _dict_items(value).get(b"/Filter", b"")
            if b"FlateDecode" in filt and filt.count(b"/") == 1:
                stream = zlib.decompress(stream)
            elif filt.strip():
                raise Unsupported("filtre de contenu non géré")
            out.append(stream)
        return b"\n".join(out)


# --------------------------------------------------------------------------- #
# Écriture du PDF
# --------------------------------------------------------------------------- #

def fmt(x):
    s = ("%.4f" % x).rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


class PdfWriter:
    def __init__(self):
        self.objs = []  # index = numéro - 1

    def alloc(self):
        self.objs.append(None)
        return len(self.objs)

    def set(self, num, body):
        self.objs[num - 1] = body

    def add(self, body):
        num = self.alloc()
        self.set(num, body)
        return num

    def add_stream(self, entries, data, compress=True):
        if compress:
            data = zlib.compress(data, 6)
            entries += " /Filter /FlateDecode"
        head = ("<< %s /Length %d >>\nstream\n" % (entries, len(data))).encode("latin-1")
        return self.add(head + data + b"\nendstream")

    def save(self, path, root, info):
        out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for i, body in enumerate(self.objs, 1):
            offsets.append(len(out))
            out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
        xref = len(out)
        out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(self.objs) + 1)
        for off in offsets:
            out += b"%010d 00000 n \n" % off
        out += ("trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n"
                % (len(self.objs) + 1, root, info, xref)).encode()
        with open(path, "wb") as fh:
            fh.write(out)

    # -- intégration d'une page d'un autre PDF sous forme de Form XObject -- #
    def embed_pdf_page(self, data, index=0):
        src = PdfSource(data)
        box, resources, contents = src.page(index)
        mapping = {}
        pending = []

        def remap(text):
            def sub(m):
                n = int(m.group(1))
                if n not in mapping:
                    mapping[n] = self.alloc()
                    pending.append(n)
                return b"%d 0 R" % mapping[n]
            return _REF_RE.sub(sub, text)

        res = remap(resources)
        content = src.content_bytes(contents)
        while pending:
            n = pending.pop()
            value, stream = src.objs[n]
            if stream is None:
                self.set(mapping[n], remap(value))
            else:
                value = re.sub(rb"/Length\s+\d+(\s+\d+\s+R)?", b"/Length %d" % len(stream), value, count=1)
                self.set(mapping[n], remap(value) + b"\nstream\n" + stream + b"\nendstream")
        entries = "/Type /XObject /Subtype /Form /BBox [%s] /Resources %s" % (
            " ".join(fmt(v) for v in box), res.decode("latin-1"))
        return self.add_stream(entries, content), box


def jpeg_info(data):
    """(largeur, hauteur, composantes) d'un JPEG, ou None."""
    if data[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 4 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        (ln,) = struct.unpack_from(">H", data, i + 2)
        if marker in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack_from(">HH", data, i + 5)
            return w, h, data[i + 9]
        i += 2 + ln
    return None


def add_image(writer, data):
    """Ajoute une image au PDF -> numéro d'objet (ou None si impossible)."""
    info = jpeg_info(data)
    if info and info[2] in (1, 3):
        w, h, comps = info
        try:  # l'orientation EXIF n'est pas connue des PDF : on la applique si Pillow est là
            from PIL import Image, ImageOps
            import io
            im = Image.open(io.BytesIO(data))
            if im.getexif().get(0x0112, 1) != 1:
                info = None
                raise ImportError
        except ImportError:
            pass
        if info:
            cs = "/DeviceRGB" if comps == 3 else "/DeviceGray"
            return writer.add_stream(
                "/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace %s "
                "/BitsPerComponent 8 /Filter /DCTDecode" % (w, h, cs), data, compress=False)
    try:
        from PIL import Image, ImageOps
        import io
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
        smask = None
        if im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info:
            im = im.convert("RGBA")
            a = im.getchannel("A")
            smask = writer.add_stream(
                "/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray "
                "/BitsPerComponent 8" % a.size, a.tobytes())
        rgb = im.convert("RGB")
        extra = " /SMask %d 0 R" % smask if smask else ""
        return writer.add_stream(
            "/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB "
            "/BitsPerComponent 8%s" % (rgb.width, rgb.height, extra), rgb.tobytes())
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# Conversion
# --------------------------------------------------------------------------- #

DEFAULT_SCALE = 6 / 11           # unités Goodnotes -> points (fonds standard)
DEFAULT_UNITS = (834.24, 1078.825)   # page A4-ish de la tablette utilisée en exemple


def pdf_string(s):
    return "<" + ("﻿" + s).encode("utf-16-be").hex() + ">"


def convert(src, dst, background=True, log=print):
    def warn(msg):
        log("  attention : " + msg)

    doc = Document(src, warn)
    w = PdfWriter()
    catalog, pages_root = w.alloc(), w.alloc()
    gs_alpha = {}
    templates, images = {}, {}
    page_objs = []

    def alpha_gs(a, multiply=False):
        """État graphique (opacité, éventuellement mode Multiply) -> nom de ressource."""
        key = (round(a, 3), multiply)
        if key not in gs_alpha:
            blend = "/BM /Multiply " if multiply else ""
            gs_alpha[key] = w.add(("<< /Type /ExtGState %s/CA %s /ca %s >>" % (
                blend, fmt(key[0]), fmt(key[0]))).encode())
        return "GA%d%s" % (round(key[0] * 1000), "M" if multiply else ""), gs_alpha[key]

    for n, (note_name, attach, size) in enumerate(doc.pages, 1):
        log("page %d/%d" % (n, len(doc.pages)))
        if doc.has(note_name):
            items = read_page(doc.read(note_name), warn)
        else:
            items = []
            warn("contenu de la page introuvable (%s)" % note_name)

        # fond de page
        tpl_name = None
        pw, ph = (size or DEFAULT_UNITS)
        scale = DEFAULT_SCALE
        page_w, page_h = pw * scale, ph * scale
        if background and attach and doc.has("attachments/" + attach):
            if attach not in templates:
                try:
                    templates[attach] = w.embed_pdf_page(doc.read("attachments/" + attach))
                except (Unsupported, ValueError, KeyError, IndexError, zlib.error) as e:
                    templates[attach] = None
                    warn("fond de page non reproduit (%s)" % e)
            if templates[attach]:
                tpl_name = "T%d" % templates[attach][0]
                box = templates[attach][1]
                page_w, page_h = box[2] - box[0], box[3] - box[1]
                scale = page_w / pw
        res_x, res_gs = {}, {}
        if tpl_name:
            res_x[tpl_name] = templates[attach][0]
        s = fmt(scale)
        out = []
        if tpl_name:
            out.append("/%s Do" % tpl_name)
        for it in items:
            if it.kind == "image":
                if it.image not in images:
                    name = "attachments/" + it.image
                    images[it.image] = add_image(w, doc.read(name)) if doc.has(name) else None
                    if images[it.image] is None:
                        warn("image non reproduite (%s)" % it.image[:8])
                if images[it.image] is None:
                    continue
                res_x["I%d" % images[it.image]] = images[it.image]
                x, y, iw, ih, ang = it.rect
                # image en (0,0)-(1,1) ; on la place dans le repère "unités" avec y vers le bas
                out.append("q %s 0 0 %s %s %s cm" % (s, "-" + s, fmt((x + it.tx) * scale),
                                                     fmt(page_h - (y + it.ty) * scale)))
                if ang:
                    out.append("1 0 0 1 %s %s cm %s %s %s %s 0 0 cm 1 0 0 1 %s %s cm" % (
                        fmt(iw / 2), fmt(ih / 2), fmt(math.cos(ang)), fmt(math.sin(ang)),
                        fmt(-math.sin(ang)), fmt(math.cos(ang)), fmt(-iw / 2), fmt(-ih / 2)))
                out.append("%s 0 0 %s 0 %s cm /I%d Do Q" % (fmt(iw), fmt(-ih), fmt(ih), images[it.image]))
                continue

            head = "q %s 0 0 -%s %s %s cm" % (s, s, fmt(it.tx * scale), fmt(page_h - it.ty * scale))
            path = path_to_pdf(it.ops, fmt)
            if it.kind == "shape":
                name, res_gs[name] = alpha_gs(it.fill[3])
                out.append("%s /%s gs %s %s %s rg\n%s\nf Q" % (head, name, *(fmt(v) for v in it.fill[:3]), path))
                continue
            r, g, b, a = it.color
            state = "%s %s %s RG %s w 1 J 1 j" % (fmt(r), fmt(g), fmt(b), fmt(it.width))
            gs = ""
            if it.blend or a < 0.999:  # le surligneur est multiplié avec le fond
                name, res_gs[name] = alpha_gs(a, multiply=it.blend)
                gs = "/%s gs " % name
            out.append("%s %s%s\n%s\nS Q" % (head, gs, state, path))

        content = w.add_stream("", "\n".join(out).encode("latin-1"))
        resources = "/ExtGState << %s >> /XObject << %s >>" % (
            " ".join("/%s %d 0 R" % kv for kv in res_gs.items()),
            " ".join("/%s %d 0 R" % kv for kv in res_x.items()))
        page_objs.append(w.add((
            "<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %s %s] /Contents %d 0 R "
            "/Resources << %s >> >>" % (pages_root, fmt(page_w), fmt(page_h), content, resources)).encode()))

    w.set(pages_root, ("<< /Type /Pages /Count %d /Kids [%s] >>" % (
        len(page_objs), " ".join("%d 0 R" % p for p in page_objs))).encode())
    w.set(catalog, ("<< /Type /Catalog /Pages %d 0 R >>" % pages_root).encode())
    title = os.path.splitext(os.path.basename(src))[0]
    info = w.add(("<< /Title %s /Producer (goodnotes2pdf) >>" % pdf_string(title)).encode())
    w.save(dst, catalog, info)


def main():
    ap = argparse.ArgumentParser(description="Convertit des fichiers Goodnotes (.goodnotes) en PDF.")
    ap.add_argument("fichiers", nargs="+", help="fichier(s) .goodnotes")
    ap.add_argument("-o", "--sortie", help="PDF de sortie (un seul fichier d'entrée)")
    ap.add_argument("-f", "--forcer", action="store_true", help="écraser un PDF existant")
    ap.add_argument("--sans-fond", action="store_true", help="ne pas reproduire le fond des pages")
    args = ap.parse_args()
    if args.sortie and len(args.fichiers) > 1:
        ap.error("-o ne peut pas être utilisé avec plusieurs fichiers")
    status = 0
    for src in args.fichiers:
        dst = args.sortie or os.path.splitext(src)[0] + ".pdf"
        if os.path.exists(dst) and not args.forcer:
            print("%s : %s existe déjà (utiliser -f pour l'écraser ou -o pour un autre nom)" % (src, dst),
                  file=sys.stderr)
            status = 1
            continue
        print("%s -> %s" % (src, dst))
        try:
            convert(src, dst, background=not args.sans_fond)
        except (OSError, zipfile.BadZipFile, KeyError, ValueError) as e:
            print("  erreur : %s" % e, file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
