"""Copy a Word document with Leaf's comment threads written in as Word comments.

The original file is never changed. Each thread's quote is found in the document's runs the way the
reader indexes them (whitespace collapsed, paragraphs separated by a space), the runs at either end
are split, and the passage is wrapped in Word's comment range. Threads whose quote can't be placed
attach to the start of the document, quoting the passage they were about.
"""
from datetime import datetime, timezone
import copy
from pathlib import Path
import re
import shutil
import tempfile
import zipfile
from xml.etree import ElementTree
from comments import exact_span
from docx_text import W, read_part

NS = W[1:-1]
COMMENTS_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'
COMMENTS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'


def parse_keeping_prefixes(raw):
    """Parse a part so it serializes with its original prefixes and root declarations.

    Word refuses parts that lose namespace declarations named in mc:Ignorable, which ElementTree
    drops when they are unused; the original root start tag is put back on write.
    """
    text = raw.decode('utf-8')
    for prefix, uri in re.findall(r'xmlns:(\w+)="([^"]+)"', text):
        try:
            ElementTree.register_namespace(prefix, uri)
        except ValueError:
            pass  # ElementTree reserves ns0, ns1, …; it names those itself.
    root_tag = re.search(r'<(?!\?)(?!!)[^>]+>', text).group(0)
    return ElementTree.fromstring(raw), root_tag


def serialize(root, root_tag):
    """Write a part back with its original root start tag."""
    body = ElementTree.tostring(root, encoding='unicode')
    body = re.sub(r'^<[^>]+>', lambda _: root_tag if not root_tag.endswith('/>') else root_tag[:-2] + '>', body, count=1)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + body).encode('utf-8')


def w(tag):
    return W + tag


def own_nodes(paragraph):
    """A paragraph's own descendants in document order, without the paragraphs nested inside it."""
    nested = {id(node) for inner in paragraph.iter(w('p')) if inner is not paragraph for node in inner.iter()}
    return [node for node in paragraph.iter() if id(node) not in nested]


def index_text(body):
    """The reader's text of the body, and for each character the text element and offset it came from.

    Tabs read as a space; paragraphs are separated by a space. Whitespace collapses as it does in
    the reader's quotes, so positions map back only to kept characters.
    """
    chars, places = [], []

    def add(char, place):
        if char.isspace():
            if not chars or chars[-1] == ' ':
                return
            char, place = ' ', None
        chars.append(char)
        places.append(place)

    for paragraph in body.iter(w('p')):
        for node in own_nodes(paragraph):
            if node.tag == w('t') and node.text:
                for offset, char in enumerate(node.text):
                    add(char, (node, offset))
            elif node.tag == w('tab'):
                add(' ', None)
        add(' ', None)
    return ''.join(chars), places


def parents_of(root):
    return {child: parent for parent in root.iter() for child in parent}


def split_run(run, text_node, offset, parents):
    """Split `run` before character `offset` of `text_node`; returns the run holding the rest."""
    parent = parents[run]
    rest = ElementTree.Element(w('r'), run.attrib)
    properties = run.find(w('rPr'))
    if properties is not None:
        rest.append(copy.deepcopy(properties))
    tail = ElementTree.SubElement(rest, w('t'))
    tail.text = text_node.text[offset:]
    tail.set(XML_SPACE, 'preserve')
    text_node.text = text_node.text[:offset]
    text_node.set(XML_SPACE, 'preserve')
    children = list(run)
    for child in children[children.index(text_node) + 1:]:
        run.remove(child)
        rest.append(child)
    parent.insert(list(parent).index(run) + 1, rest)
    parents[rest] = parent
    for child in rest:
        parents[child] = rest
    return rest


def place(body, quote_start, quote_end, places, comment_id):
    """Wrap the characters [quote_start, quote_end) in a comment range with its reference."""
    kept = [i for i in range(quote_start, quote_end) if places[i]]
    if not kept:
        return False
    first_node, first_offset = places[kept[0]]
    last_node, last_offset = places[kept[-1]]
    parents = parents_of(body)
    # The end first: splitting there leaves the start's text element and offset unchanged.
    last_run = parents[last_node]
    after = split_run(last_run, last_node, last_offset + 1, parents)
    holder = parents[after]
    at = list(holder).index(after)
    end = ElementTree.Element(w('commentRangeEnd'), {w('id'): str(comment_id)})
    reference = ElementTree.Element(w('r'))
    ElementTree.SubElement(reference, w('commentReference'), {w('id'): str(comment_id)})
    holder.insert(at, end)
    holder.insert(at + 1, reference)
    first_run = parents[first_node]
    start_run = split_run(first_run, first_node, first_offset, parents)
    holder = parents[start_run]
    holder.insert(list(holder).index(start_run), ElementTree.Element(w('commentRangeStart'), {w('id'): str(comment_id)}))
    return True


def place_at_start(body, comment_id):
    """Attach a comment to the first paragraph, for threads without a placeable passage."""
    paragraph = next(body.iter(w('p')), None)
    if paragraph is None:
        return False
    properties = paragraph.find(w('pPr'))
    at = 1 if properties is not None else 0
    paragraph.insert(at, ElementTree.Element(w('commentRangeStart'), {w('id'): str(comment_id)}))
    paragraph.append(ElementTree.Element(w('commentRangeEnd'), {w('id'): str(comment_id)}))
    reference = ElementTree.SubElement(paragraph, w('r'))
    ElementTree.SubElement(reference, w('commentReference'), {w('id'): str(comment_id)})
    return True


def initials(name):
    return ''.join(part[0] for part in name.split()[:3]).upper() or 'L'


def comment_element(comment_id, thread, unplaced):
    """A Word comment holding the thread: its body, then each reply and status change."""
    element = ElementTree.Element(w('comment'), {w('id'): str(comment_id), w('author'): thread['author'],
                                                 w('date'): thread['created'][:19] + 'Z', w('initials'): initials(thread['author'])})
    lines = []
    if unplaced and thread.get('anchor'):
        lines.append(f"On “{thread['anchor']['quote'][:200]}”:")
    lines.append(thread['body'])
    for reply in thread['replies']:
        status = f"marked {reply['status']}" + (': ' if reply.get('body') else '') if reply.get('status') else ''
        lines.append(f"{reply['author']}: {status}{reply.get('body', '')}")
    for index, line in enumerate(lines):
        paragraph = ElementTree.SubElement(element, w('p'))
        if index == 0:
            ElementTree.SubElement(ElementTree.SubElement(paragraph, w('r')), w('annotationRef'))
        for number, part in enumerate(line.split('\n')):
            run = ElementTree.SubElement(paragraph, w('r'))
            if number:
                ElementTree.SubElement(run, w('br'))
            text = ElementTree.SubElement(run, w('t'))
            text.text = part
            text.set(XML_SPACE, 'preserve')
    return element


def output_path(path):
    """`name (Leaf comments).docx` beside the original, numbered rather than overwriting."""
    base = path.with_name(f'{path.stem} (Leaf comments).docx')
    candidate, number = base, 2
    while candidate.exists():
        candidate = path.with_name(f'{path.stem} (Leaf comments {number}).docx')
        number += 1
    return candidate


def export_word_comments(path, threads):
    """Write a copy of the document with `threads` as Word comments; report where each landed."""
    path = Path(path)
    with zipfile.ZipFile(path) as archive:
        parts = {info.filename: read_part(archive, info.filename) for info in archive.infolist() if not info.is_dir()}
        infos = archive.infolist()
    document, document_tag = parse_keeping_prefixes(parts['word/document.xml'])
    body = document.find(w('body'))
    if body is None:
        raise ValueError('This Word document has no body.')
    if 'word/comments.xml' in parts:
        comments, comments_tag = parse_keeping_prefixes(parts['word/comments.xml'])
    else:
        comments = ElementTree.Element(w('comments'))
        comments_tag = f'<w:comments xmlns:w="{NS}">'
        ElementTree.register_namespace('w', NS)
    used = [int(item.get(w('id'))) for item in document.iter() if item.tag in (w('commentRangeStart'), w('comment'), w('commentReference')) and (item.get(w('id')) or '').isdigit()]
    used += [int(item.get(w('id'))) for item in comments.iter(w('comment')) if (item.get(w('id')) or '').isdigit()]
    next_id = max(used, default=-1) + 1
    placed, unplaced = 0, 0
    for thread in threads:
        landed = False
        if thread.get('anchor'):
            text, places = index_text(body)
            state, start, end = exact_span(thread['anchor'], text)
            landed = state == 'attached' and place(body, start, end, places, next_id)
        if not landed and not place_at_start(body, next_id):
            continue
        comments.append(comment_element(next_id, thread, not landed and bool(thread.get('anchor'))))
        placed += landed
        unplaced += not landed
        next_id += 1
    parts['word/document.xml'] = serialize(document, document_tag)
    parts['word/comments.xml'] = serialize(comments, comments_tag)
    if '[Content_Types].xml' in parts and b'/word/comments.xml' not in parts['[Content_Types].xml']:
        parts['[Content_Types].xml'] = parts['[Content_Types].xml'].replace(
            b'</Types>', f'<Override PartName="/word/comments.xml" ContentType="{COMMENTS_TYPE}"/></Types>'.encode())
    rels = parts.get('word/_rels/document.xml.rels', f'<Relationships xmlns="{PACKAGE_RELS}"></Relationships>'.encode())
    if COMMENTS_REL.encode() not in rels:
        taken = set(re.findall(rb'Id="([^"]+)"', rels))
        rel_id, number = 'rIdLeafComments', 1
        while rel_id.encode() in taken:
            rel_id, number = f'rIdLeafComments{number}', number + 1
        parts['word/_rels/document.xml.rels'] = rels.replace(
            b'</Relationships>', f'<Relationship Id="{rel_id}" Type="{COMMENTS_REL}" Target="comments.xml"/></Relationships>'.encode())
    target = output_path(path)
    names = [info.filename for info in infos if not info.is_dir()]
    names += [name for name in parts if name not in names]
    # Write beside the target, then move it in, so a failure never leaves half a document.
    with tempfile.NamedTemporaryFile(dir=target.parent, suffix='.docx', delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as out:
            for name in names:
                out.writestr(name, parts[name])
        shutil.move(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return {'path': str(target), 'placed': placed, 'unplaced': unplaced,
            'exported': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}
