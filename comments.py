"""Store document discussions and derive conservative locations from current text."""
import copy
from datetime import datetime, timezone
import re
from pathlib import Path
import uuid
import zipfile
from xml.etree import ElementTree
from docx_text import docx_text, is_docx


def text_field(value, name, limit=50000, empty=False):
    """Reject malformed or oversized input before any discussion is changed."""
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ValueError(f'{name} must be text of at most {limit} characters.')
    return value


def anchor_value(value):
    """Validate a rendered quote selector while retaining optional context hints."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError('Anchor must be an object or null.')
    result = {'quote': ' '.join(text_field(value.get('quote'), 'quote', 20000).split())}
    for key, limit in (('prefix', 32), ('suffix', 32), ('heading', 1000)):
        if key in value:
            result[key] = text_field(value[key], key, limit, empty=True)
    return result


def apply_comment_action(data, command, extensions):
    """Apply one validated thread mutation; status events remain in the timeline."""
    action = command['action']
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    author = text_field(command.get('author', 'agent'), 'author', 120)
    threads = data['comments']
    if action == 'comment-add':
        path = Path(command.get('path', '')).expanduser().resolve(strict=True)
        if not path.is_file() or path.suffix.lower() not in extensions:
            raise ValueError('Choose a supported text document.')
        threads.append({'id': 'k_' + uuid.uuid4().hex[:12], 'path': str(path),
                        'anchor': enrich_anchor(anchor_value(command.get('anchor')), read_document(path)),
                        'body': text_field(command.get('body'), 'body'), 'author': author,
                        'created': now, 'updated': now, 'status': 'open',
                        'statusBy': author, 'statusAt': now, 'replies': []})
        return
    thread = next((item for item in threads if item['id'] == command.get('id')), None)
    if thread is None:
        raise ValueError('Comment does not exist.')
    reply = None
    if 'reply' in command:
        reply = next((item for item in thread['replies'] if item['id'] == command['reply']), None)
        if reply is None:
            raise ValueError('Reply does not exist.')
    if action == 'comment-delete':
        if reply is None:
            threads.remove(thread)
        else:
            thread['replies'].remove(reply)
    elif action == 'comment-edit':
        target = thread if reply is None else reply
        target['body'] = text_field(command.get('body'), 'body', empty=bool(target.get('status') and reply is not None))
        target['edited'] = now
    elif action in ('comment-reply', 'comment-status'):
        event = {'id': 'r_' + uuid.uuid4().hex[:12], 'author': author, 'created': now}
        if action == 'comment-status':
            status = command.get('status')
            if status not in ('open', 'working', 'resolved'):
                raise ValueError('Status must be open, working, or resolved.')
            event.update(status=status, body=text_field(command.get('note', ''), 'note', empty=True))
            thread.update(status=status, statusBy=author, statusAt=now)
        else:
            event['body'] = text_field(command.get('body'), 'body')
        thread['replies'].append(event)
    elif action == 'comment-anchor':
        if 'anchor' not in command:
            raise ValueError('Provide an anchor or null.')
        thread['anchor'] = anchor_value(command['anchor'])
    else:
        raise ValueError('Unknown comment action.')
    thread['updated'] = now


def normalized(source, markdown=False):
    """Collapse whitespace and optionally remove Markdown syntax with source offsets."""
    skip = set()
    if markdown:
        # Keep link labels, but exclude destinations, tags and line-level markup.
        for pattern in (r'!?\[([^\]]+)\]\([^\n)]*\)', r'<[^>\n]+>', r'(?m)^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+\.\s+)', r'(?m)^\s*```[^\n]*'):
            for match in re.finditer(pattern, source):
                keep = set(range(*match.span(1))) if match.lastindex else set()
                skip.update(set(range(*match.span())) - keep)
    chars, offsets = [], []
    for index, char in enumerate(source):
        if index in skip or (markdown and char in '*_`~'):
            continue
        if char.isspace():
            if not chars or chars[-1] == ' ':
                continue
            char = ' '
        chars.append(char)
        offsets.append(index)
    return ''.join(chars), offsets


def exact_span(anchor, text):
    """Select an exact quote only when its context has a unique best match."""
    quote = anchor['quote']
    matches = [m.start() for m in re.finditer('(?=' + re.escape(quote) + ')', text)]
    if len(matches) > 1:
        prefix = ' '.join(anchor.get('prefix', '').split())
        suffix = ' '.join(anchor.get('suffix', '').split())
        scores = [(int(bool(prefix) and text[:i].rstrip().endswith(prefix)) +
                   int(bool(suffix) and text[i + len(quote):].lstrip().startswith(suffix)), i) for i in matches]
        best = max(score for score, _ in scores)
        matches = [i for score, i in scores if score == best]
    if len(matches) > 1:
        return 'ambiguous', None, None
    if not matches:
        return 'detached', None, None
    return 'attached', matches[0], matches[0] + len(quote)


def heading_trail(source, offset):
    """Collect Markdown heading ancestors before the selection, excluding fenced code."""
    trail, fence = [], None
    lines = source[:offset].splitlines()
    for index, line in enumerate(lines):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if marker:
            token = marker[1]
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        if fence:
            continue
        match = re.match(r'^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$', line)
        if match:
            level, title = len(match[1]), match[2]
        elif index and re.fullmatch(r' {0,3}(?:=+|-+)\s*', line) and lines[index - 1].strip():
            level, title = (1 if '=' in line else 2), lines[index - 1]
        else:
            continue
        while trail and trail[-1][0] >= level:
            trail.pop()
        trail.append((level, normalized(title, True)[0].strip()))
    return ' › '.join(title for _, title in trail)[:1000]


def enrich_anchor(anchor, source):
    """Fill absent context only for a unique quote, preserving explicit UI selectors."""
    if anchor is None or source is None:
        return anchor
    text, offsets = normalized(source, True)
    state, start, end = exact_span(anchor, text)
    if state != 'attached':
        return anchor
    result = dict(anchor)
    for key, value in (('prefix', text[max(0, start - 32):start]),
                       ('suffix', text[end:end + 32]),
                       ('heading', heading_trail(source, offsets[start]))):
        if not result.get(key):
            result[key] = value
    return result


def locate(thread, source):
    """Derive exact or changed-text lines; retain detached and ambiguous threads."""
    result = {'state': 'detached', 'line': None, 'endLine': None}
    anchor = thread.get('anchor')
    if anchor is None:
        return dict(result, state='attached')
    if source is None:
        return result
    views = [normalized(source, stripped) for stripped in (False, True)]
    for text, offsets in views:
        state, start, end = exact_span(anchor, text)
        if state == 'ambiguous':
            return dict(result, state=state)
        if state == 'attached':
            return {'state': state, 'line': source.count('\n', 0, offsets[start]) + 1,
                    'endLine': source.count('\n', 0, offsets[end - 1]) + 1}
    # Match the UI's conservative changed-passage fallback after exact matching fails.
    prefix = re.sub(r'\s+', ' ', anchor.get('prefix', ''))
    suffix = re.sub(r'\s+', ' ', anchor.get('suffix', ''))
    if len(prefix) >= 12 and len(suffix) >= 12:
        for text, offsets in views:
            before = text.find(prefix)
            if before < 0 or text.find(prefix, before + 1) >= 0:
                continue
            start = before + len(prefix)
            end = text.find(suffix, start)
            if start < end <= start + len(anchor['quote']) * 3 + 200:
                return {'state': 'changed', 'line': source.count('\n', 0, offsets[start]) + 1,
                        'endLine': source.count('\n', 0, offsets[end - 1]) + 1}
    return result


def read_document(path):
    """Read bounded UTF-8 text, or a Word document's paragraphs, or return unavailable without
    losing stored comments."""
    try:
        if not Path(path).is_file():
            return None
        if is_docx(path):
            return docx_text(path)
        with Path(path).open('rb') as stream:
            raw = stream.read(10 * 1024 * 1024 + 1)
        return raw.decode('utf-8') if len(raw) <= 10 * 1024 * 1024 else None
    except (OSError, UnicodeError, ValueError, zipfile.BadZipFile, ElementTree.ParseError):
        return None


def list_comments(data, paths=None, statuses=None):
    """Read bounded current files once per path and attach derived location metadata."""
    result, sources = [], {}
    for thread in data.get('comments', []):
        path = thread['path']
        if (paths is not None and path not in paths) or (statuses is not None and thread['status'] not in statuses):
            continue
        if path not in sources:
            sources[path] = read_document(path)
        result.append(dict(copy.deepcopy(thread), location=locate(thread, sources[path])))
    return result


def markdown_comments(threads):
    """Print the complete visible timeline and location hints for an editing agent."""
    lines = ['# Leaf comments', '']
    if not threads:
        lines.append('No matching comments.')
    for thread in threads:
        location = thread['location']
        unit = 'paragraph' if is_docx(thread['path']) else 'line'
        where = f"{location['state']} · {unit} {location['line']}" if location['line'] else location['state']
        lines.extend([f"## {thread['id']} · {thread['status']} · {where}", '', thread['path'], ''])
        if thread['anchor']:
            lines.append('> ' + thread['anchor']['quote'].replace('\n', '\n> '))
            if thread['anchor'].get('heading'):
                lines.append('Heading: ' + thread['anchor']['heading'])
            lines.append('')
        lines.append(f"{thread['author']} · {thread['created']}: {thread['body']}")
        for reply in thread['replies']:
            status = ('marked ' + reply['status'] + ': ') if reply.get('status') else ''
            lines.append(f"{reply['author']} · {reply['created']}: {status}{reply['body']}")
        lines.append('')
    return '\n'.join(lines)
