"""Prove Word documents read as paragraphs for comment locations and export threads as Word comments."""
from pathlib import Path
import tempfile
import unittest
import zipfile
from comments import apply_comment_action, list_comments, markdown_comments
from docx_comments import export_word_comments
from docx_text import docx_text
from workspace import COMMENT_EXTENSIONS, empty_workspace

NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' \
     'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"'
STYLES = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles {NS}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Custom"><w:name w:val="Section title"/><w:basedOn w:val="Heading1"/></w:style></w:styles>'''
BODY = '''<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Summary</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Revenue grew in </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>all three regions</w:t></w:r><w:r><w:t>.</w:t></w:r>
<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>4,682</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:pPr><w:pStyle w:val="Custom"/></w:pPr><w:r><w:t>Risks</w:t></w:r></w:p>
<w:p><w:r><w:t>It applies automatically.</w:t></w:r></w:p><w:p><w:r><w:t>We recommend option B.</w:t></w:r></w:p>'''


def write_docx(path, body=BODY):
    """A minimal package: document, styles, footnotes, relationships and content types."""
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                         '<Default Extension="xml" ContentType="application/xml"/></Types>')
        archive.writestr('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         '<Relationship Id="rId1" Type="styles" Target="styles.xml"/></Relationships>')
        archive.writestr('word/document.xml', f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {NS}><w:body>{body}</w:body></w:document>')
        archive.writestr('word/styles.xml', STYLES)
        archive.writestr('word/footnotes.xml', f'<?xml version="1.0"?><w:footnotes {NS}><w:footnote w:id="1"><w:p><w:r><w:t>A footnote.</w:t></w:r></w:p></w:footnote></w:footnotes>')


class DocxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'report.docx'
        write_docx(self.path)
        self.data = empty_workspace()

    def comment(self, quote, body='Check this.'):
        apply_comment_action(self.data, {'action': 'comment-add', 'path': str(self.path), 'anchor': {'quote': quote}, 'body': body}, COMMENT_EXTENSIONS)
        return self.data['comments'][-1]

    def test_text_is_one_line_per_paragraph_with_headings_marked(self):
        self.assertEqual(docx_text(self.path).splitlines(), [
            '# Summary', 'Revenue grew in all three regions.', 'Cell one', '4,682', '# Risks',
            'It applies automatically.', 'We recommend option B.', 'A footnote.'])

    def test_comments_locate_by_paragraph_and_take_the_heading_trail(self):
        thread = self.comment('in all three regions')
        self.assertEqual(thread['anchor']['heading'], 'Summary')
        [listed] = list_comments(self.data, [str(self.path)])
        self.assertEqual(listed['location'], {'state': 'attached', 'line': 2, 'endLine': 2})
        self.assertIn('attached · paragraph 2', markdown_comments([listed]))

    def test_export_wraps_passages_in_word_comments_and_keeps_the_original(self):
        original = self.path.read_bytes()
        self.comment('in all three regions', 'Which regions?')
        self.comment('applies automatically. We recommend', 'Spans two paragraphs.')
        self.comment('4,682', 'Check with Finance.')
        self.comment('no longer in the document', 'Detached.')
        result = export_word_comments(self.path, list_comments(self.data, [str(self.path)]))
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual((result['placed'], result['unplaced']), (3, 1))
        target = Path(result['path'])
        self.assertEqual(target.name, 'report (Leaf comments).docx')
        with zipfile.ZipFile(target) as archive:
            document = archive.read('word/document.xml').decode()
            comments = archive.read('word/comments.xml').decode()
            types = archive.read('[Content_Types].xml').decode()
            rels = archive.read('word/_rels/document.xml.rels').decode()
        # Root declarations named in mc:Ignorable survive, or Word refuses the file.
        self.assertIn('xmlns:w14=', document)
        self.assertIn('mc:Ignorable="w14"', document)
        self.assertEqual(document.count('<w:commentRangeStart'), 4)
        self.assertEqual(document.count('<w:commentReference'), 4)
        # The quote's text sits between its range markers, split out of the surrounding runs.
        start, end = document.index('<w:commentRangeStart w:id="0"'), document.index('<w:commentRangeEnd w:id="0"')
        between = ''.join(part.split('>')[-1] for part in document[start:end].split('</w:t>'))
        self.assertEqual(between, 'in all three regions')
        self.assertIn('Revenue grew ', document[:start])
        self.assertIn('Which regions?', comments)
        self.assertIn('On “no longer in the document”:', comments)
        self.assertIn('/word/comments.xml', types)
        self.assertIn('relationships/comments', rels)
        again = export_word_comments(self.path, list_comments(self.data, [str(self.path)]))
        self.assertEqual(Path(again['path']).name, 'report (Leaf comments 2).docx')
        self.assertEqual(docx_text(target), docx_text(self.path))


if __name__ == '__main__':
    unittest.main()
