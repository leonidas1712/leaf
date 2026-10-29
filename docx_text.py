"""Read a Word document's text for comment locations: one line per paragraph, headings marked."""
from pathlib import Path
import zipfile
from xml.etree import ElementTree

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
# Word files are zipped; the unpacked document XML is bounded separately from the file.
XML_LIMIT = 64 * 1024 * 1024


def heading_levels(archive):
    """Map paragraph style ids to heading levels, from outline levels or "heading N" names."""
    try:
        root = ElementTree.fromstring(read_part(archive, 'word/styles.xml'))
    except (KeyError, ElementTree.ParseError, ValueError):
        return {}
    styles, based = {}, {}
    for style in root.iter(W + 'style'):
        if style.get(W + 'type') != 'paragraph':
            continue
        sid = style.get(W + 'styleId')
        name = (style.find(W + 'name').get(W + 'val') if style.find(W + 'name') is not None else '').lower()
        outline = style.find(f'{W}pPr/{W}outlineLvl')
        if outline is not None and (outline.get(W + 'val') or '').isdigit() and int(outline.get(W + 'val')) < 6:
            styles[sid] = int(outline.get(W + 'val')) + 1
        elif name.startswith('heading ') and name[8:].isdigit() and 1 <= int(name[8:]) <= 6:
            styles[sid] = int(name[8:])
        elif name == 'title':
            styles[sid] = 1
        parent = style.find(W + 'basedOn')
        if parent is not None:
            based[sid] = parent.get(W + 'val')
    # A style based on a heading is a heading of the same level.
    for sid in list(based):
        seen, current = set(), sid
        while current not in styles and current in based and current not in seen:
            seen.add(current)
            current = based[current]
        if current in styles:
            styles.setdefault(sid, styles[current])
    return styles


def read_part(archive, name):
    """Read one part of the package, refusing ones that unpack beyond the limit."""
    info = archive.getinfo(name)
    if info.file_size > XML_LIMIT:
        raise ValueError('Word document part is too large.')
    return archive.read(info)


def paragraph_text(paragraph):
    """Visible text of a paragraph as the reader indexes it: runs and tabs, but not line breaks
    (which render as no text), field codes, deletions, footnote numbers, or the paragraphs nested
    inside it (text boxes), which are read on their own."""
    nested = {id(node) for inner in paragraph.iter(W + 'p') if inner is not paragraph for node in inner.iter()}
    parts = []
    for node in paragraph.iter():
        if id(node) in nested:
            continue
        if node.tag == W + 't' and node.text:
            parts.append(node.text)
        elif node.tag == W + 'tab':
            parts.append(' ')
        elif node.tag == W + 'noBreakHyphen':
            parts.append('-')
    return ''.join(parts)


def docx_text(path):
    """The document as Markdown-like text: one line per paragraph, `#` marking heading levels.

    Paragraphs in tables count too, and footnotes and endnotes follow the body, so a comment's
    line is the paragraph number Leaf reports for Word documents.
    """
    with zipfile.ZipFile(path) as archive:
        levels = heading_levels(archive)
        lines = []
        for part in ('word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'):
            try:
                root = ElementTree.fromstring(read_part(archive, part))
            except KeyError:
                continue
            for paragraph in root.iter(W + 'p'):
                text = paragraph_text(paragraph)
                style = paragraph.find(f'{W}pPr/{W}pStyle')
                level = levels.get(style.get(W + 'val')) if style is not None else None
                if part != 'word/document.xml' and not text.strip():
                    continue
                lines.append(('#' * level + ' ' if level and text.strip() else '') + text)
    return '\n'.join(lines) + '\n'


def is_docx(path):
    """Word documents are read through their XML; other documents are UTF-8 text."""
    return Path(path).suffix.lower() == '.docx'
