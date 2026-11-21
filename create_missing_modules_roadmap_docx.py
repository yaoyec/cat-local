from pathlib import Path
import re
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.shared import Cm, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(__file__).parent
SRC = ROOT / "猫猫放置-缺失模块实施路线图.md"
OUT = ROOT / "猫猫放置-缺失模块实施路线图.docx"
FONT = "微软雅黑"
MONO = "Consolas"
NAVY, BLUE, GRAY, BLACK, WHITE = "17365D", "2F5597", "666666", "222222", "FFFFFF"
LIGHT_BLUE, PALE_BLUE, PALE_AMBER = "D9EAF7", "EAF2F8", "FFF2CC"


def east_asia(run, font=FONT):
    run.font.name = font
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), font)


def fmt_run(run, size=10.2, bold=False, color=BLACK, font=FONT, italic=False):
    east_asia(run, font)
    run.font.size = Pt(size)
    run.bold = bold
    run.italic = italic
    run.font.color.rgb = RGBColor.from_string(color)


def shade(cell, color):
    pr = cell._tc.get_or_add_tcPr()
    shd = pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        pr.append(shd)
    shd.set(qn("w:fill"), color)


def repeat_header(row):
    pr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:tblHeader")
    el.set(qn("w:val"), "true")
    pr.append(el)


def no_split(row):
    pr = row._tr.get_or_add_trPr()
    pr.append(OxmlElement("w:cantSplit"))


def inline(paragraph, text, size=10.2, color=BLACK):
    pattern = re.compile(r"(\*\*.+?\*\*|`.+?`)")
    pos = 0
    for match in pattern.finditer(text):
        if match.start() > pos:
            r = paragraph.add_run(text[pos:match.start()])
            fmt_run(r, size=size, color=color)
        token = match.group(0)
        if token.startswith("**"):
            r = paragraph.add_run(token[2:-2])
            fmt_run(r, size=size, bold=True, color=color)
        else:
            r = paragraph.add_run(token[1:-1])
            fmt_run(r, size=size-0.4, color=BLUE, font=MONO)
        pos = match.end()
    if pos < len(text):
        r = paragraph.add_run(text[pos:])
        fmt_run(r, size=size, color=color)


def add_page_num(p):
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r = p.add_run("第 ")
    fmt_run(r, size=8.5, color=GRAY)
    begin = OxmlElement("w:fldChar"); begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText"); instr.set(qn("xml:space"), "preserve"); instr.text = " PAGE "
    end = OxmlElement("w:fldChar"); end.set(qn("w:fldCharType"), "end")
    r._r.extend([begin, instr, end])
    r2 = p.add_run(" 页"); fmt_run(r2, size=8.5, color=GRAY)


def add_cover(doc):
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; p.paragraph_format.space_before = Pt(72)
    r = p.add_run("猫猫放置"); fmt_run(r, size=18, bold=True, color=BLUE)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("缺失模块实施路线图"); fmt_run(r, size=29, bold=True, color=NAVY)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; p.paragraph_format.space_after = Pt(35)
    r = p.add_run("基于当前前后端源码的只读审计 · 从易到难 / 依赖优先"); fmt_run(r, size=12, color=GRAY)
    table = doc.add_table(rows=5, cols=2); table.alignment = WD_TABLE_ALIGNMENT.CENTER
    rows = [("文档版本", "v1.0"), ("基准日期", "2026-11-18（Asia/Shanghai）"), ("项目", "maomao-idle"), ("文档性质", "实施规划 / 审计结论"), ("业务源码", "本轮未修改")]
    for row, (a, b) in zip(table.rows, rows):
        shade(row.cells[0], LIGHT_BLUE)
        for cell, value, bold in [(row.cells[0], a, True), (row.cells[1], b, False)]:
            cell.text = ""; cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            p = cell.paragraphs[0]; p.paragraph_format.space_after = Pt(0)
            r = p.add_run(value); fmt_run(r, size=9.5, bold=bold, color=NAVY if bold else BLACK)
        no_split(row)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; p.paragraph_format.space_before = Pt(32)
    r = p.add_run("核心原则：先让契约诚实，再补状态与持久化；完整验收后才恢复入口。"); fmt_run(r, size=11, bold=True, color="C00000")
    doc.add_page_break()


def add_md_table(doc, lines):
    rows = []
    for line in lines:
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        rows.append(cells)
    if len(rows) >= 2 and all(re.fullmatch(r":?-{3,}:?", c.replace(" ", "")) for c in rows[1]):
        rows.pop(1)
    table = doc.add_table(rows=1, cols=len(rows[0])); table.style = "Table Grid"; table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, text in enumerate(rows[0]):
        cell = table.rows[0].cells[i]; shade(cell, NAVY); cell.text = ""
        p = cell.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER; p.paragraph_format.space_after = Pt(0)
        inline(p, text, size=9.2, color=WHITE)
        for r in p.runs: r.bold = True
    repeat_header(table.rows[0])
    for src in rows[1:]:
        cells = table.add_row().cells
        for i, value in enumerate(src):
            cells[i].text = ""; cells[i].vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            p = cells[i].paragraphs[0]; p.paragraph_format.space_after = Pt(0)
            inline(p, value, size=8.8)
        no_split(table.rows[-1])
    doc.add_paragraph().paragraph_format.space_after = Pt(0)


def render(md):
    doc = Document()
    sec = doc.sections[0]
    sec.top_margin, sec.bottom_margin, sec.left_margin, sec.right_margin = Cm(1.7), Cm(1.6), Cm(1.8), Cm(1.8)
    sec.header_distance, sec.footer_distance = Cm(0.7), Cm(0.7)
    normal = doc.styles["Normal"]
    normal.font.name = FONT; normal._element.rPr.rFonts.set(qn("w:eastAsia"), FONT); normal.font.size = Pt(10.2)
    normal.paragraph_format.line_spacing = 1.18; normal.paragraph_format.space_after = Pt(5)
    for name, size, color in [("Heading 1", 18, NAVY), ("Heading 2", 13.5, BLUE), ("Heading 3", 11.5, BLUE)]:
        st = doc.styles[name]; st.font.name = FONT; st._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
        st.font.size = Pt(size); st.font.bold = True; st.font.color.rgb = RGBColor.from_string(color)
        st.paragraph_format.keep_with_next = True; st.paragraph_format.space_before = Pt(12); st.paragraph_format.space_after = Pt(5)
    for name in ["List Bullet", "List Bullet 2", "List Number"]:
        st = doc.styles[name]; st.font.name = FONT; st._element.rPr.rFonts.set(qn("w:eastAsia"), FONT); st.font.size = Pt(10.2)
    hp = sec.header.paragraphs[0]; r = hp.add_run("猫猫放置 · 缺失模块实施路线图"); fmt_run(r, size=8.5, bold=True, color=GRAY)
    add_page_num(sec.footer.paragraphs[0])
    add_cover(doc)

    lines = md.splitlines()
    i = 0
    first_h1 = True
    while i < len(lines):
        line = lines[i].rstrip()
        if not line:
            i += 1; continue
        if line.startswith("| "):
            tbl = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                tbl.append(lines[i]); i += 1
            add_md_table(doc, tbl); continue
        if line.startswith("# "):
            title = line[2:].strip()
            if title == "猫猫放置：缺失模块实施路线图":
                i += 1; continue
            if not first_h1: doc.add_page_break()
            first_h1 = False
            doc.add_heading(title, level=1); i += 1; continue
        if line.startswith("## "):
            doc.add_heading(line[3:].strip(), level=2); i += 1; continue
        if line.startswith("### "):
            doc.add_heading(line[4:].strip(), level=3); i += 1; continue
        if line.startswith("> "):
            p = doc.add_paragraph(); p.paragraph_format.left_indent = Cm(0.5); p.paragraph_format.right_indent = Cm(0.3)
            p.paragraph_format.space_before = Pt(3); p.paragraph_format.space_after = Pt(6)
            inline(p, line[2:].strip(), size=9.8)
            for r in p.runs: r.font.color.rgb = RGBColor.from_string("7F6000")
            i += 1; continue
        m = re.match(r"^\s*(-|\*)\s+(.+)$", line)
        if m:
            p = doc.add_paragraph(style="List Bullet"); p.paragraph_format.space_after = Pt(2.5)
            inline(p, m.group(2)); i += 1; continue
        m = re.match(r"^\s*\d+\.\s+(.+)$", line)
        if m:
            p = doc.add_paragraph(style="List Number"); p.paragraph_format.space_after = Pt(2.5)
            inline(p, m.group(1)); i += 1; continue
        p = doc.add_paragraph(); p.paragraph_format.space_after = Pt(4)
        inline(p, line); i += 1

    doc.core_properties.title = "猫猫放置缺失模块实施路线图"
    doc.core_properties.subject = "从易到难、依赖优先的缺失模块实施清单"
    doc.core_properties.author = "DeepSeek Harness"
    doc.core_properties.keywords = "猫猫放置, 缺失模块, 路线图, Socket, 持久化, 验收"
    return doc


doc = render(SRC.read_text(encoding="utf-8"))
doc.save(OUT)
# Reopen to verify package and key content.
check = Document(OUT)
text = "\n".join(p.text for p in check.paragraphs)
required = ["执行摘要", "共享经济事务与持久任务底座", "完整交互式“垂钓”", "所有模块统一的上线门槛"]
missing = [item for item in required if item not in text]
if missing:
    raise RuntimeError(f"Document verification failed; missing: {missing}")
print(f"created={OUT}")
print(f"paragraphs={len(check.paragraphs)} tables={len(check.tables)} sections={len(check.sections)}")
