"""Prove text selected in a compiled PDF finds the LaTeX source behind it, and listings take folders."""
import gzip
from pathlib import Path
import tempfile
import unittest
from comments import anchor_value, apply_comment_action, list_comments, markdown_comments, section_trail
from tex import SyncIndex
from tex_anchor import pdf_anchor, source_span
from workspace import COMMENT_EXTENSIONS, empty_workspace

SOURCE = r'''\section{Introduction}
\label{sec:intro}
Multi-agent systems built from large language models are increasingly deployed
% TODO: cite the auction paper here
A worrying failure mode is \textbf{collusion}: agents that quietly cooperate
against the interests of the people who deployed them~\cite{smith2024}.

\subsection{Probes}
For each reply we average the residual-stream vectors at layer $\ell = 12$,
giving one vector per reply, with weight decay $\lambda = 10^{-3}$.
'''


def quote(selected, first, last=None):
    start, end, how = source_span(SOURCE, first, last or first, selected)
    return SOURCE[start:end], how


class SourceSpanTests(unittest.TestCase):
    def test_words_are_found_through_markup_line_breaks_and_hyphenation(self):
        self.assertEqual(quote('collusion: agents that quietly cooperate against the', 5, 6),
                         ('collusion}: agents that quietly cooperate\nagainst the', 'text'))
        self.assertEqual(quote('increasingly de- ployed', 3)[0], 'increasingly deployed')
        self.assertEqual(quote('ﬁ', 3)[1], 'line')  # too short to place: the line itself

    def test_citations_and_math_are_bridged_by_the_letters_that_agree(self):
        # The citation's number has no letters in the source; the words around it still place the quote.
        self.assertEqual(quote('who deployed them [1].', 6), ('who deployed them', 'text'))
        text, how = quote('vectors at layer ℓ = 12, giving one vector', 9, 10)
        self.assertEqual(how, 'text')
        self.assertTrue(text.startswith('vectors at layer $\\ell = 12$,') and text.endswith('giving one vector'), text)

    def test_the_occurrence_nearest_the_synctex_line_wins(self):
        source = 'the probe\n' + 'filler\n' * 30 + 'the probe\n'
        start, _, _ = source_span(source, 31, 31, 'the probe')
        self.assertEqual(source.count('\n', 0, start) + 1, 32)

    def test_unmatched_selections_quote_the_nearest_lines_with_text(self):
        source = 'First line.\n\n\nLast line.\n'
        # Lines 2 and 4 are equally near line 3; the blank one is passed over, and on a tie the later wins.
        self.assertEqual(source_span(source, 3, 3, 'Something else entirely'), (14, 24, 'line'))
        self.assertEqual(source_span(source, 2, 2, 'Something else entirely'), (0, 11, 'line'))

    def test_anchor_quotes_source_with_context_heading_and_the_pdf_text(self):
        result = pdf_anchor(SOURCE, 5, 5, 'quietly cooperate', 1)
        anchor = result['anchor']
        self.assertEqual(anchor['quote'], 'quietly cooperate')
        self.assertTrue(anchor['prefix'].endswith('agents that '))
        self.assertTrue(anchor['suffix'].startswith(' against the'))
        self.assertEqual(anchor['heading'], 'Introduction')
        self.assertEqual(anchor['pdf'], {'page': 1, 'text': 'quietly cooperate'})
        self.assertEqual((result['line'], result['endLine'], result['match']), (5, 5, 'text'))
        self.assertEqual(section_trail(SOURCE, SOURCE.index('weight decay')), 'Introduction › Probes')
        self.assertEqual(section_trail(SOURCE, SOURCE.index('Probes')), 'Introduction › Probes')


class FineInverseTests(unittest.TestCase):
    """A paragraph's line boxes carry the line where it ended; glue on the baseline names the real line."""

    def test_glue_on_the_baseline_decides_the_line(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            sp = 65781.76
            point = lambda kind, line, x, y: f'{kind}1,{line}:{int(x * sp)},{int(y * sp)}'
            content = '\n'.join([
                'SyncTeX Version:1', f'Input:1:{root}/main.tex', 'Output:pdf', 'Unit:1', 'X Offset:0', 'Y Offset:0', 'Content:', '{1',
                # Two typeset lines of one paragraph that ended on source line 9.
                f'(1,9:{int(72 * sp)},{int(110 * sp)}:{int(400 * sp)},{int(8 * sp)},{int(2 * sp)}',
                point('g', 5, 72, 110), point('g', 6, 250, 110), ')',
                f'(1,9:{int(72 * sp)},{int(124 * sp)}:{int(400 * sp)},{int(8 * sp)},{int(2 * sp)}',
                point('k', 7, 72, 124), ')', '}1', 'Postamble:',
            ])
            path = root / 'main.synctex.gz'
            with gzip.open(path, 'wt') as stream:
                stream.write(content)
            index = SyncIndex(path, root)
            self.assertEqual(index.inverse(1, 100, 106)['line'], 5)
            self.assertEqual(index.inverse(1, 300, 106)['line'], 6)
            self.assertEqual(index.inverse(1, 300, 120)['line'], 7)


class ListingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'paper' / 'sections').mkdir(parents=True)
        self.data = empty_workspace()
        for name in ('paper/main.tex', 'paper/sections/intro.tex', 'notes.md'):
            (self.root / name).write_text(SOURCE)
            apply_comment_action(self.data, {'action': 'comment-add', 'path': str(self.root / name),
                                             'anchor': {'quote': 'quietly cooperate'}, 'body': 'Check.'}, COMMENT_EXTENSIONS)

    def test_a_folder_lists_every_document_under_it(self):
        listed = list_comments(self.data, [str(self.root / 'paper')])
        self.assertEqual(sorted(Path(t['path']).name for t in listed), ['intro.tex', 'main.tex'])
        self.assertEqual(len(list_comments(self.data, [str(self.root / 'notes.md')])), 1)
        self.assertEqual(list_comments(self.data, [str(self.root / 'pap')]), [])

    def test_latex_comments_take_their_sections_and_keep_the_pdf_selection(self):
        intro = [t for t in self.data['comments'] if t['path'].endswith('intro.tex')][0]
        self.assertEqual(intro['anchor']['heading'], 'Introduction')
        notes = [t for t in self.data['comments'] if t['path'].endswith('notes.md')][0]
        self.assertEqual(notes['anchor']['heading'], '')
        apply_comment_action(self.data, {'action': 'comment-add', 'path': str(self.root / 'paper/main.tex'), 'body': 'From the PDF.',
                                         'anchor': {'quote': 'quietly cooperate', 'pdf': {'page': 2, 'text': 'quietly\n cooperate'}}},
                             COMMENT_EXTENSIONS)
        self.assertEqual(self.data['comments'][-1]['anchor']['pdf'], {'page': 2, 'text': 'quietly cooperate'})
        printed = markdown_comments(list_comments(self.data, [str(self.root / 'paper/main.tex')]))
        self.assertIn('Selected in the PDF, page 2: “quietly cooperate”', printed)
        for bad in ({'page': 0, 'text': 'x'}, {'page': True, 'text': 'x'}, {'page': 1}, 'page 1'):
            with self.assertRaises(ValueError):
                anchor_value({'quote': 'q', 'pdf': bad})


if __name__ == '__main__':
    unittest.main()
