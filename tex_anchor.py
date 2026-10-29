"""Turn a passage selected in a compiled PDF into a quote anchor on the LaTeX source behind it.

SyncTeX names the file and lines that typeset the selection. The selected words are then found in
that source by their letters and digits alone, so markup (\\emph{...}, braces, comments, line
breaks, hyphenation) does not get in the way. Text the PDF shows but the source spells differently,
such as citations or math, is bridged by a fuzzy match of what does agree. When nothing matches,
the anchor quotes the source lines themselves, so the comment still lands in the right file.
"""
from difflib import SequenceMatcher
import re
import unicodedata
from comments import COMMENT, normalized, section_trail

# Commands whose arguments never print as written: references, citations, environments, layout.
SILENT = re.compile(r'\\(?:label|ref|eqref|[cC]ref|autoref|pageref|cite[a-zA-Z]*|begin|end|includegraphics|'
                    r'[vh]space\*?|input|include|bibliography(?:style)?|usepackage|documentclass)\s*'
                    r'(?:\[[^\]\n]*\]\s*)*\{[^{}\n]*\}')
COMMAND = re.compile(r'\\(?:[a-zA-Z@]+|.)')
CONTEXT = 32


def letters(text, start=0):
    """Lowercased letters and digits of `text`, each with its offset (plus `start`)."""
    chars, offsets = [], []
    for index, char in enumerate(text):
        for part in unicodedata.normalize('NFKC', char):
            if part.isalnum():
                chars.append(part.lower())
                offsets.append(start + index)
    return ''.join(chars), offsets


def source_letters(source):
    """The letters and digits of LaTeX source that can print, with their offsets in the source."""
    hidden = bytearray(len(source))
    for pattern in (COMMENT, SILENT, COMMAND):
        for match in pattern.finditer(source):
            hidden[match.start():match.end()] = b'\1' * (match.end() - match.start())
    chars, offsets = [], []
    for index, char in enumerate(source):
        if hidden[index]:
            continue
        for part in unicodedata.normalize('NFKC', char):
            if part.isalnum():
                chars.append(part.lower())
                offsets.append(index)
    return ''.join(chars), offsets


def line_starts(source):
    starts = [0]
    for match in re.finditer('\n', source):
        starts.append(match.end())
    return starts


def line_of(starts, offset):
    low, high = 0, len(starts)
    while low + 1 < high:
        middle = (low + high) // 2
        if starts[middle] <= offset:
            low = middle
        else:
            high = middle
    return low + 1


def source_span(source, first, last, selected):
    """Find the selected PDF text in `source` near lines `first`–`last` (1-based).

    Returns (start, end, how): source offsets and 'text' for a match of the selected words, or
    'line' for the source lines themselves. None when the lines hold no text at all.
    """
    first, last = min(first, last), max(first, last)
    starts = line_starts(source)
    wanted, _ = letters(selected)
    have, offsets = source_letters(source)
    if len(wanted) >= 2:
        # Exact: every letter of the selection, in order, with only markup between. Nearest the hint wins.
        found = [match.start() for match in re.finditer('(?=' + re.escape(wanted) + ')', have)]
        if found:
            at = min(found, key=lambda index: abs(line_of(starts, offsets[index]) - first))
            if abs(line_of(starts, offsets[at]) - first) <= 40:
                return offsets[at], offsets[at + len(wanted) - 1] + 1, 'text'
        # Close: most of the letters agree in order within a few lines of the hint.
        low = starts[max(0, first - 4)]
        high = starts[last + 3] if last + 3 < len(starts) else len(source)
        window = [index for index, offset in enumerate(offsets) if low <= offset < high]
        if window:
            base = window[0]
            near = have[base:window[-1] + 1]
            blocks = [block for block in SequenceMatcher(None, wanted, near, autojunk=False).get_matching_blocks()
                      if block.size >= min(3, len(wanted))]
            matched = sum(block.size for block in blocks)
            if blocks and matched >= 0.6 * len(wanted):
                begin, end = base + blocks[0].b, base + blocks[-1].b + blocks[-1].size
                if end - begin <= 2 * len(wanted) + 40:
                    return offsets[begin], offsets[end - 1] + 1, 'text'
    # The lines SyncTeX named, widened to the nearest ones with text.
    def bounds(line):
        start = starts[line - 1] if line - 1 < len(starts) else len(source)
        end = starts[line] - 1 if line < len(starts) else len(source)
        return start, end
    total = len(starts)
    first, last = max(1, min(first, total)), max(1, min(last, total))
    for line in sorted(range(1, total + 1), key=lambda value: (abs(value - first), value < first)):
        start, end = bounds(line)
        if source[start:end].strip():
            first = line
            break
    else:
        return None
    last = max(first, last)
    start, _ = bounds(first)
    _, end = bounds(last)
    text = source[start:end]
    start += len(text) - len(text.lstrip())
    end -= len(text) - len(text.rstrip())
    return start, end, 'line'


def pdf_anchor(source, first, last, selected, page):
    """A quote anchor on `source` for text selected on a PDF page, with where it was found.

    The anchor quotes the source the way the reader indexes it (whitespace collapsed), with context
    on both sides, the enclosing sections, and the PDF selection itself for whoever reads the thread.
    """
    found = source_span(source, first, last, selected)
    if found is None:
        raise ValueError('That part of the PDF has no source text to attach to.')
    start, end, how = found
    text, offsets = normalized(source)
    begin = next((index for index, offset in enumerate(offsets) if offset >= start), len(text))
    finish = next((index for index in range(len(offsets) - 1, -1, -1) if offsets[index] < end), begin - 1) + 1
    while begin < finish and text[begin] == ' ':
        begin += 1
    while finish > begin and text[finish - 1] == ' ':
        finish -= 1
    starts = line_starts(source)
    anchor = {'quote': text[begin:finish], 'prefix': text[max(0, begin - CONTEXT):begin], 'suffix': text[finish:finish + CONTEXT],
              'pdf': {'page': int(page), 'text': ' '.join(selected.split())[:2000]}}
    heading = section_trail(source, start)
    if heading:
        anchor['heading'] = heading
    return {'anchor': anchor, 'match': how, 'line': line_of(starts, start), 'endLine': line_of(starts, max(start, end - 1))}
