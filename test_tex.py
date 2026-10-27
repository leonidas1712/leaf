"""Prove LaTeX projects resolve their main file, batch builds, report diagnostics, and map positions."""
import gzip
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import tex
from tex import Project, SyncIndex, TexProjects, find_main, parse_log


class MainFileTests(unittest.TestCase):
    """Find the file to build from wherever the reader is."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'sections').mkdir()
        (self.root / 'main.tex').write_text('\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n')
        (self.root / 'sections/intro.tex').write_text('\\section{Intro}\nText.\n')

    def test_folders_sections_and_magic_comments_resolve_the_main_file(self):
        self.assertEqual(find_main(self.root), self.root / 'main.tex')
        self.assertEqual(find_main(self.root / 'sections/intro.tex'), self.root / 'main.tex')
        (self.root / 'paper.tex').write_text('\\documentclass{article}\n')
        (self.root / 'sections/other.tex').write_text('% !TEX root = ../paper.tex\nText.\n')
        self.assertEqual(find_main(self.root / 'sections/other.tex'), self.root / 'paper.tex')

    def test_ambiguous_or_missing_main_files_ask_for_one(self):
        (self.root / 'main.tex').write_text('No class here.\n')
        (self.root / 'a.tex').write_text('\\documentclass{article}\n')
        (self.root / 'b.tex').write_text('\\documentclass{article}\n')
        with self.assertRaisesRegex(ValueError, '--main'):
            find_main(self.root)
        self.assertEqual(find_main(self.root, 'b.tex'), self.root / 'b.tex')


class CommandTests(unittest.TestCase):
    """Recompiling on request really recompiles; the project's latexmkrc keeps choosing the engine."""

    def test_manual_builds_force_latexmk_and_latexmkrc_wins(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            project = Project({'root': str(root), 'main': 'main.tex', 'engine': 'latexmk', 'bin': None}, root / 'state')
            self.assertIn('-pdf', project.command())
            self.assertNotIn('-g', project.command())
            self.assertIn('-g', project.command(force=True))
            (root / 'latexmkrc').write_text('$pdf_mode = 5;\n')
            self.assertNotIn('-pdf', project.command())


class LogTests(unittest.TestCase):
    """Turn a TeX log into errors and warnings that name files and lines."""

    def test_errors_warnings_and_boxes_name_their_files(self):
        root = Path('/paper')
        log = '\n'.join([
            'This is pdfTeX',
            '(./main.tex (./sections/intro.tex',
            './sections/intro.tex:12: Undefined control sequence.',
            'l.12 \\badmacro',
            'LaTeX Warning: Reference `fig:x\' on page 2 undefined on input line 7.',
            ')',
            '(./sections/results.tex',
            '! Missing $ inserted.',
            '<inserted text>',
            'l.30 x^',
            'Overfull \\hbox (3.2pt too wide) in paragraph at lines 40--42',
            'Package natbib Warning: Citation `smith\' on page 3 undefined on input line 44.',
            '))',
        ])
        errors, warnings, boxes = parse_log(log, root)
        self.assertEqual(errors, [
            {'path': '/paper/sections/intro.tex', 'line': 12, 'message': 'Undefined control sequence.'},
            {'path': '/paper/sections/results.tex', 'line': 30, 'message': 'Missing $ inserted.'},
        ])
        self.assertEqual([(w['path'], w['line']) for w in warnings],
                         [('/paper/sections/intro.tex', 7), ('/paper/sections/results.tex', 44)])
        self.assertTrue(warnings[1]['message'].startswith('natbib: Citation'))
        self.assertEqual(boxes, [{'path': '/paper/sections/results.tex', 'line': 40, 'message': 'Overfull \\hbox (3.2pt too wide)'}])


class SyncTests(unittest.TestCase):
    """Map source lines to page boxes and back, ignoring files outside the project."""

    def test_forward_inverse_and_page_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            sp = 65781.76
            box = lambda tag, line, x, y, w, h=8, d=2: f'({tag},{line}:{int(x * sp)},{int(y * sp)}:{int(w * sp)},{int(h * sp)},{int(d * sp)}'
            content = '\n'.join([
                'SyncTeX Version:1', f'Input:1:{root}/./main.tex', f'Input:2:{root}/./sections/intro.tex',
                f'Input:3:{root}/.tools/tex/article.cls', 'Output:pdf', 'Magnification:1000', 'Unit:1',
                'X Offset:0', 'Y Offset:0', 'Content:', '{1', box(1, 5, 72, 100, 400), ')',
                box(2, 1, 72, 200, 400), ')', box(2, 3, 72, 220, 300), ')', box(3, 9, 72, 240, 400), ')', '}1',
                '{2', box(2, 8, 72, 120, 400), ')', '}2', 'Postamble:',
            ])
            path = root / 'main.synctex.gz'
            with gzip.open(path, 'wt') as stream:
                stream.write(content)
            index = SyncIndex(path, root)
            intro = str(root / 'sections/intro.tex')
            self.assertEqual(index.forward(intro)['page'], 1)
            self.assertAlmostEqual(index.forward(intro)['y'], 192, places=0)
            nearest = index.forward(intro, 7)
            self.assertEqual((nearest['page'], nearest['line']), (2, 8))
            self.assertEqual(index.inverse(1, 100, 218), {'path': intro, 'line': 3, 'page': 1})
            self.assertEqual([s['path'] for s in index.page_sources(1)], [str(root / 'main.tex'), intro])
            self.assertNotIn(str(root / '.tools/tex/article.cls'), index.by_file)


class QueueTests(unittest.TestCase):
    """Batch edits into settled builds; respect auto-compile; discard half-edited failures."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.root = base / 'paper'
        self.root.mkdir()
        self.source = self.root / 'main.tex'
        self.source.write_text('\\documentclass{article}\n')
        self.projects = TexProjects(base / 'state')
        self.project = Project({'root': str(self.root), 'main': 'main.tex', 'engine': 'latexmk', 'bin': None}, base / 'state')
        self.projects.projects[str(self.root)] = self.project
        self.builds = []

        def fake_build(project=self.project):
            self.builds.append(time.time())
            project.result = {'ok': True}
            project.built = project.signature()
            return True

        patcher = patch.object(self.project, 'build', side_effect=fake_build)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.projects.close)

    def edit(self, text):
        self.source.write_text(text)

    def test_bursts_of_edits_become_one_build_after_they_settle(self):
        with patch.object(tex, 'QUIET', 0.6):
            self.projects.start()
            time.sleep(1.2)  # The first poll sees unbuilt sources and builds once.
            self.assertEqual(len(self.builds), 1)
            for index in range(4):
                self.edit(f'\\documentclass{{article}}\n% {index}\n')
                time.sleep(0.3)
            self.assertEqual(len(self.builds), 1)
            time.sleep(1.8)
            self.assertEqual(len(self.builds), 2)

    def test_auto_off_marks_outdated_and_a_manual_build_still_runs(self):
        self.project.auto = False
        self.projects.start()
        time.sleep(1.2)
        self.assertEqual(self.builds, [])
        self.assertEqual(self.projects.statuses()[0]['state'], 'outdated')
        project, ticket = self.projects.request(str(self.root))
        status, finished = self.projects.wait(project, ticket, 5)
        self.assertTrue(finished)
        self.assertEqual(len(self.builds), 1)
        self.assertEqual(status['state'], 'ok')


if __name__ == '__main__':
    unittest.main()
