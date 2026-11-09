#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 data/cs200/*.txt 汇总成《拼多多客服 200 问》工作簿。
用法：python3 scripts/build-cs200.py
"""
import glob
import math
import os
import re
import sys
import unicodedata

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.page import PageMargins

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "cs200")
OUT = os.path.join(ROOT, "docs", "48-拼多多客服200问.xlsx")

FONT = "微软雅黑"
GREEN = "1F6F54"
GREEN_DARK = "174F3D"
GREEN_LIGHT = "EAF4EF"
AMBER = "FFF4E2"
RED = "FDEAE7"
GRAY = "F6F7F6"
LINE = "DDE5E0"
INK = "1F2A24"
MUTED = "64756B"
WHITE = "FFFFFF"

THIN = Side(style="thin", color=LINE)
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

LEVEL_STYLE = {
    "直接答": ("E7F3EC", "1C6B4C"),
    "核对后答": ("FFF1D9", "8A5A00"),
    "转主管": ("FCE7E3", "9C2F1F"),
}


def dwidth(text):
    n = 0
    for ch in str(text):
        n += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return n


def load_rows():
    rows = []
    for path in sorted(glob.glob(os.path.join(DATA, "*.txt"))):
        with open(path, encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, 1):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("|")
                if len(parts) != 9:
                    raise SystemExit(f"{path}:{lineno} 字段数 {len(parts)} != 9")
                qid, cat, q, intent, reply, basis, level, check, avoid = [p.strip() for p in parts]
                rows.append(dict(id=qid, cat=cat, q=q, intent=intent, reply=reply,
                                 basis=basis, level=level, check=check, avoid=avoid))
    return rows


def validate(rows):
    main = [r for r in rows if not r["id"].startswith("K")]
    appx = [r for r in rows if r["id"].startswith("K")]
    problems = []
    if len(main) != 200:
        problems.append(f"主表 {len(main)} 条，应为 200")
    if len(appx) != 30:
        problems.append(f"附录 {len(appx)} 条，应为 30")
    ids = [r["id"] for r in rows]
    if len(set(ids)) != len(ids):
        problems.append("编号重复：" + ",".join(sorted({i for i in ids if ids.count(i) > 1})))
    qs = [r["q"] for r in rows]
    if len(set(qs)) != len(qs):
        dup = sorted({q for q in qs if qs.count(q) > 1})
        problems.append("问题重复：" + "；".join(dup))
    banned = ["绝对", "保证", "百分百", "包您", "亲亲", "宝子", "爱您", "100%", "最好", "第一", "顶级", "国家级"]
    for r in rows:
        for w in banned:
            if w in r["reply"]:
                problems.append(f"{r['id']} 回复含禁词「{w}」：{r['reply']}")
        if not (6 <= len(r["reply"]) <= 140):
            problems.append(f"{r['id']} 回复长度 {len(r['reply'])} 异常")
        if r["level"] not in LEVEL_STYLE:
            problems.append(f"{r['id']} 处理方式非法：{r['level']}")
        for col in ("q", "intent", "basis"):
            if not r[col]:
                problems.append(f"{r['id']} {col} 为空")
        if r["avoid"] and not r["avoid"].startswith("❌"):
            problems.append(f"{r['id']} 别这样说未以 ❌ 开头")
        if r["level"] == "核对后答" and not r["check"]:
            problems.append(f"{r['id']} 核对后答但没写核对项")
    if problems:
        print("校验未通过：")
        for p in problems:
            print(" -", p)
        raise SystemExit(1)
    print(f"校验通过：主表 {len(main)} 条，附录 {len(appx)} 条")


def style_cell(cell, size=10, bold=False, color=INK, fill=None, align="left",
               wrap=True, border=True):
    cell.font = Font(name=FONT, size=size, bold=bold, color=color)
    cell.alignment = Alignment(horizontal=align, vertical="center", wrap_text=wrap,
                               shrink_to_fit=False, indent=1 if align == "left" else 0)
    if fill:
        cell.fill = PatternFill("solid", fgColor=fill)
    if border:
        cell.border = BORDER


def row_height(values, widths, size=10, minimum=22, maximum=170):
    lines = 1
    for text, width in zip(values, widths):
        if text is None:
            continue
        units = max(dwidth(text), 1)
        avail = max(width * 1.0 - 1.5, 6)
        lines = max(lines, math.ceil(units / avail))
    return max(minimum, min(maximum, lines * (size * 1.55) + 7))


def section_row(ws, row, text, ncols, fill=GREEN, color=WHITE, size=11):
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=ncols)
    cell = ws.cell(row=row, column=1, value=text)
    cell.font = Font(name=FONT, size=size, bold=True, color=color)
    cell.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    cell.fill = PatternFill("solid", fgColor=fill)
    for c in range(1, ncols + 1):
        ws.cell(row=row, column=c).border = BORDER
    ws.row_dimensions[row].height = size * 2.2


def build_method_sheet(wb):
    ws = wb.active
    ws.title = "① 回复方法"
    ws.sheet_view.showGridLines = False
    widths = [4, 16, 64, 36]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ncols = 4

    ws.merge_cells("A1:D1")
    c = ws["A1"]
    c.value = "客服回复一页纸：先判断，再说话"
    c.font = Font(name=FONT, size=18, bold=True, color=WHITE)
    c.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    c.fill = PatternFill("solid", fgColor=GREEN_DARK)
    ws.row_dimensions[1].height = 32

    ws.merge_cells("A2:D2")
    c = ws["A2"]
    c.value = ("200 条话术是结果，这一页是判断方法。规则来自店铺知识库、商品说明书和平台通用规则。\n"
               "G 列标记：🟢 直接答 · 🟡 先核对 H 列再发 · 🔴 先共情、再转主管。价格、库存、时效发前看页面。")
    c.font = Font(name=FONT, size=9, color="3D4F45")
    c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=1)
    c.fill = PatternFill("solid", fgColor=GREEN_LIGHT)
    ws.row_dimensions[2].height = 32

    r = 4
    section_row(ws, r, "一、四步回复法：任何问题都先走这四步", ncols, size=10.5)
    ws.row_dimensions[r].height = 22
    r += 1
    steps = [
        ("1", "接住", "先回应人：在的呢 / 您先别急哈 / 给您添麻烦了", "不要一上来就讲规则"),
        ("2", "给事实", "只说确定的；不确定就说去哪儿看", "不编数字，不说「资料里没有」"),
        ("3", "给下一步", "给一个买家能做的动作：下单 / 申请售后", "不一次甩三个方案"),
        ("4", "收住", "一句能说完不说两句；不追加承诺", "不把一句话说成一段"),
    ]
    for num, label, do, dont in steps:
        ws.cell(row=r, column=1, value=num)
        ws.cell(row=r, column=2, value=label)
        ws.cell(row=r, column=3, value=do)
        ws.cell(row=r, column=4, value=dont)
        for col in range(1, ncols + 1):
            style_cell(ws.cell(row=r, column=col), size=9.5, bold=(col == 2),
                       color=INK if col != 4 else "A33A28",
                       align="center" if col == 1 else "left")
        ws.row_dimensions[r].height = 26
        r += 1

    r += 1
    section_row(ws, r, "二、六条铁律：记住这六句，比背 200 条有用", ncols, size=10.5)
    ws.row_dimensions[r].height = 22
    r += 1
    rules = [
        ("1", "答其所问", "问有没有货，只答有货；不问价不报价，不问替代品不推荐"),
        ("2", "先情绪后事实", "催发货、售后、投诉，第一句先接住，再讲规则"),
        ("3", "事实优先", "快递、时效、发票、退换，先查再答；表里 H 列就是先查什么"),
        ("4", "查不到给出口", "不说「不知道 / 没有」，说「以页面标注为准」，再给一个动作"),
        ("5", "不替商家否定", "资质、报告、服务，没查到不等于没有；先确认，再正面回答"),
        ("6", "温度在人", "亲 / 哈 / 呢可以用；亲亲、宝子、绝对、包您满意不能用"),
    ]
    for num, label, do in rules:
        ws.cell(row=r, column=1, value=num)
        ws.cell(row=r, column=2, value=label)
        ws.merge_cells(start_row=r, start_column=3, end_row=r, end_column=4)
        ws.cell(row=r, column=3, value=do)
        for col in range(1, ncols + 1):
            style_cell(ws.cell(row=r, column=col), size=9.5, bold=(col == 2),
                       align="center" if col == 1 else "left")
        ws.row_dimensions[r].height = 24
        r += 1

    r += 1
    section_row(ws, r, "三、三种承诺：只有「态度」可以随便给", ncols, size=10.5)
    ws.row_dimensions[r].height = 22
    r += 1
    commits = [
        ("✅", "态度承诺", "「给您添麻烦了」「我们会跟进」", "可以给，买家要的是确定感", GREEN_LIGHT, "1C6B4C"),
        ("❌", "结果承诺", "「补发 / 退款 / 赔您 / 一定能到 / 有检测报告」", "要授权，别替店铺做主", RED, "9C2F1F"),
        ("❌", "流程承诺", "「安排人 / 稍后回复 / 把单号发我」", "自动回复里后面没人接，不能说", RED, "9C2F1F"),
    ]
    for mark, label, example, why, fill, color in commits:
        ws.cell(row=r, column=1, value=mark)
        ws.cell(row=r, column=2, value=label)
        ws.cell(row=r, column=3, value=example)
        ws.cell(row=r, column=4, value=why)
        for col in range(1, ncols + 1):
            style_cell(ws.cell(row=r, column=col), size=9.5, bold=(col == 2),
                       color=color, fill=fill, align="center" if col == 1 else "left")
        ws.row_dimensions[r].height = 30
        r += 1

    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=4)
    c = ws.cell(row=r, column=1,
                value="人工客服可以查单、可以要一次照片；红线不是「不许问」，而是「别把查一下说成保证解决」。")
    style_cell(c, size=9, color="6B5300", fill=AMBER, align="left")
    ws.row_dimensions[r].height = 22
    r += 2

    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=4)
    c = ws.cell(row=r, column=1,
                value=("发出去之前自问三句：① 是不是替店铺许了不该许的愿？   "
                       "② 问的那一项答了吗、有没有多答？   ③ 下一轮我还接得住吗？"))
    style_cell(c, size=9.5, bold=True, fill=GREEN_LIGHT, color=GREEN_DARK)
    ws.row_dimensions[r].height = 30

    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 1
    ws.page_margins = PageMargins(left=0.35, right=0.35, top=0.35, bottom=0.35)
    ws.print_area = f"A1:D{r}"


def build_table_sheet(wb, title, subtitle, rows, name, start_row=4, freeze="A4"):
    ws = wb.create_sheet(name)
    ws.sheet_view.showGridLines = False
    widths = [6, 12, 27, 19, 56, 29, 10, 19, 28]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ncols = len(widths)

    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncols)
    c = ws.cell(row=1, column=1, value=title)
    c.font = Font(name=FONT, size=16, bold=True, color=WHITE)
    c.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    c.fill = PatternFill("solid", fgColor=GREEN_DARK)
    ws.row_dimensions[1].height = 34

    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=ncols)
    c = ws.cell(row=2, column=1, value=subtitle)
    c.font = Font(name=FONT, size=9, color="3D4F45")
    c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=1)
    c.fill = PatternFill("solid", fgColor=GREEN_LIGHT)
    ws.row_dimensions[2].height = 24

    headers = ["序号", "分类", "买家原话", "他真正想确认", "建议回复（可直接发）",
               "依据与边界", "处理方式", "发送前核对", "别这样说"]
    for col, h in enumerate(headers, 1):
        c = ws.cell(row=3, column=col, value=h)
        style_cell(c, size=10, bold=True, color=WHITE, fill=GREEN, align="center")
    ws.row_dimensions[3].height = 30

    r = start_row
    for idx, item in enumerate(rows):
        ws.cell(row=r, column=1, value=item["id"])
        ws.cell(row=r, column=2, value=item["cat"])
        ws.cell(row=r, column=3, value=item["q"])
        ws.cell(row=r, column=4, value=item["intent"])
        ws.cell(row=r, column=5, value=item["reply"])
        ws.cell(row=r, column=6, value=item["basis"])
        ws.cell(row=r, column=7, value=item["level"])
        ws.cell(row=r, column=8, value=item["check"])
        ws.cell(row=r, column=9, value=item["avoid"])

        band = WHITE if idx % 2 == 0 else GRAY
        for col in range(1, ncols + 1):
            fill = band
            color = INK
            bold = False
            align = "left"
            if col == 1:
                align = "center"
                color = MUTED
            if col == 2:
                bold = True
                color = GREEN_DARK
            if col == 5:
                color = INK
            if col == 6:
                color = MUTED
                size = 9
            else:
                size = 10
            if col == 7:
                fill, color = LEVEL_STYLE[item["level"]]
                bold = True
                align = "center"
            if col == 8:
                color = "8A5A00"
            if col == 9:
                color = "9C2F1F"
                size = 9
            style_cell(ws.cell(row=r, column=col), size=size, bold=bold, color=color,
                       fill=fill, align=align)
        ws.row_dimensions[r].height = row_height(
            [item["cat"], item["q"], item["intent"], item["reply"], item["basis"], item["check"], item["avoid"]],
            [widths[1], widths[2], widths[3], widths[4], widths[5], widths[7], widths[8]], 10)
        r += 1

    last = r - 1
    ws.freeze_panes = freeze
    ws.auto_filter.ref = f"A3:I{last}"
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A3
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.print_title_rows = "1:3"
    ws.page_margins = PageMargins(left=0.3, right=0.3, top=0.4, bottom=0.4)
    return ws, last


def build_stats_sheet(wb, rows, name="④ 分类与计划"):
    ws = wb.create_sheet(name)
    ws.sheet_view.showGridLines = False
    widths = [7, 20, 9, 14, 62]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ncols = len(widths)

    ws.merge_cells("A1:E1")
    c = ws["A1"]
    c.value = "200 条怎么用：先背哪类、七天怎么练"
    c.font = Font(name=FONT, size=16, bold=True, color=WHITE)
    c.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    c.fill = PatternFill("solid", fgColor=GREEN_DARK)
    ws.row_dimensions[1].height = 34

    section_row(ws, 3, "一、10 类问题的配比与背诵顺序（顺序是建议，不是统计）", ncols)
    headers = ["顺序", "分类", "条数", "建议先背", "为什么排这个位置"]
    for col, h in enumerate(headers, 1):
        style_cell(ws.cell(row=4, column=col, value=h), size=10, bold=True,
                   color=WHITE, fill=GREEN, align="center")
    plan = [
        ("发货与物流", "第 1 天", "问得最多，答错立刻挨骂；时效、快递、改地址都在这里"),
        ("退换与售后", "第 1 天", "涉及钱，最容易升级成投诉；先学会不承诺结果"),
        ("发芽与质量", "第 2 天", "决定复购和差评；先问清播种情况再判断责任"),
        ("种植方法", "第 2 天", "买家种得成不成，决定他会不会回来；品种不同答案不同"),
        ("价格与优惠", "第 3 天", "议价高频；用活动价和组合装接，不硬拒也不松价"),
        ("商品与品种", "第 3 天", "真假、对版、保质期，是下单前的信任关"),
        ("库存与下单", "第 4 天", "流程类，照页面说就行，别替仓库答应"),
        ("发票与资质", "第 4 天", "低频但敏感；不否定、不编证号"),
        ("支付与账号", "第 5 天", "平台功能为主，答错也容易纠正"),
        ("情绪与边界", "第 5 天", "条数少但最难；先接情绪，再划边界"),
    ]
    counts = {}
    for item in rows:
        counts[item["cat"]] = counts.get(item["cat"], 0) + 1
    r = 5
    for i, (cat, day, why) in enumerate(plan, 1):
        ws.cell(row=r, column=1, value=i)
        ws.cell(row=r, column=2, value=cat)
        ws.cell(row=r, column=3, value=counts.get(cat, 0))
        ws.cell(row=r, column=4, value=day)
        ws.cell(row=r, column=5, value=why)
        for col in range(1, ncols + 1):
            style_cell(ws.cell(row=r, column=col), size=10, bold=(col == 2),
                       align="center" if col in (1, 3, 4) else "left",
                       fill=WHITE if i % 2 else GRAY)
        ws.row_dimensions[r].height = row_height([why], [widths[4]], 10)
        r += 1

    r += 1
    section_row(ws, r, "二、7 天上手：每天 40 分钟，练到能不看答案", ncols)
    r += 1
    head2 = ["天数", "练什么", "怎么练", "", "过关标准"]
    for col, h in enumerate(head2, 1):
        if col == 4:
            continue
        style_cell(ws.cell(row=r, column=col, value=h), size=10, bold=True,
                   color=WHITE, fill=GREEN, align="center")
    ws.merge_cells(start_row=r, start_column=3, end_row=r, end_column=4)
    r += 1
    days = [
        ("第 1 天", "发货 + 售后", "遮住 E 列，按买家原话自己回 20 条，再对照", "20 条里至少 16 条不承诺结果"),
        ("第 2 天", "种植 + 发芽", "挑 20 条，先判断「品种是否已知」，再决定答还是问", "不会把所有品种答成一套"),
        ("第 3 天", "价格 + 商品", "练 15 条议价和真假质疑，要求不贬低同行、不绝对化", "没有一句「绝对 / 保证」"),
        ("第 4 天", "库存 + 发票", "练 15 条核对类，先写「要查什么」再写回复", "每条都能说出核对项"),
        ("第 5 天", "支付 + 边界", "练 12 条站外、索要、情绪场景", "拒绝时不生硬，不泄露隐私"),
        ("第 6 天", "混合抽测", "从 200 条随机抽 30 条，限时 15 分钟", "正确率 90%，且无越界承诺"),
        ("第 7 天", "复盘", "把答错的抄进自己的小本，标注错在哪一步", "同一类错不超过 2 次"),
    ]
    for i, (day, what, how, ok) in enumerate(days):
        ws.cell(row=r, column=1, value=day)
        ws.cell(row=r, column=2, value=what)
        ws.merge_cells(start_row=r, start_column=3, end_row=r, end_column=4)
        ws.cell(row=r, column=3, value=how)
        ws.cell(row=r, column=5, value=ok)
        for col in range(1, ncols + 1):
            style_cell(ws.cell(row=r, column=col), size=9.5, bold=(col == 2),
                       align="center" if col == 1 else "left",
                       fill=WHITE if i % 2 == 0 else GRAY)
        ws.row_dimensions[r].height = row_height([how, ok], [widths[2] + widths[3], widths[4]], 9.5)
        r += 1

    r += 1
    section_row(ws, r, "三、遇到表里没有的问题，按这个顺序处理", ncols)
    r += 1
    fallback = [
        "先问自己：这件事的事实归谁管？商品、说明书、店铺政策，还是平台规则。",
        "能找到依据的，按依据答；找不到的，给页面出口，不编。",
        "涉及钱、责任、投诉的，先共情，再转主管，不自己定方案。",
        "答完把新问法记下来，补进这张表——下周它就变成你的肌肉记忆。",
    ]
    for i, text in enumerate(fallback, 1):
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=ncols)
        c = ws.cell(row=r, column=1, value=f"{i}. {text}")
        style_cell(c, size=10, fill=WHITE if i % 2 else GRAY)
        ws.row_dimensions[r].height = 26
        r += 1

    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0


def build_todo_sheet(wb, name="⑤ 待确认事实"):
    ws = wb.create_sheet(name)
    ws.sheet_view.showGridLines = False
    widths = [6, 26, 18, 34, 38, 10]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ncols = len(widths)

    ws.merge_cells("A1:F1")
    c = ws["A1"]
    c.value = "这些店铺事实确认后，回复会更硬气"
    c.font = Font(name=FONT, size=16, bold=True, color=WHITE)
    c.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    c.fill = PatternFill("solid", fgColor=GREEN_DARK)
    ws.row_dimensions[1].height = 34

    ws.merge_cells("A2:F2")
    c = ws["A2"]
    c.value = ("表里带「以页面为准」的回复不是偷懒，是还没拿到店铺确认。下面每确认一条，就把对应行改成确定说法。")
    c.font = Font(name=FONT, size=9.5, color="3D4F45")
    c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=1)
    c.fill = PatternFill("solid", fgColor=GREEN_LIGHT)
    ws.row_dimensions[2].height = 28

    headers = ["编号", "需要确认的事实", "影响的行", "现在的写法", "确认后怎么改", "状态"]
    for col, h in enumerate(headers, 1):
        style_cell(ws.cell(row=3, column=col, value=h), size=10, bold=True,
                   color=WHITE, fill=GREEN, align="center")
    ws.row_dimensions[3].height = 28

    items = [
        ("仓库在哪个城市", "F16", "「以商品页标注为准」", "改成具体城市，如「山东寿光发货」"),
        ("顺丰、京东等指定快递能不能发、要不要补运费", "F05 / F07 / F22", "「备注试试，以实际发货为准」", "改成「可以发 / 发不了」，补运费写清金额"),
        ("缺货品种的补货周期", "E02 / E03", "「补货时间说不准」", "改成「一般 3~5 天补一次」"),
        ("批次检测报告的编号与可提供范围", "C14 / H10", "「有批次检测报告」", "确认能否发买家；能发就写「可提供电子版」"),
        ("检疫证明有没有、能否提供", "C15 / H09", "「以包装和页面标注为准」", "有就正面说；没有就只说包装标注，不否定"),
        ("专票税点、开票时长", "H02 / H04 / H05", "「走对公流程」", "写清税点和几个工作日，避免二次追问"),
        ("退货地址是否就是页面地址", "G24", "「以页面显示为准」", "确认后可直接给地址，减少一轮"),
        ("节假日发货安排", "F18", "「以页面公告为准」", "写清哪天截单、哪天恢复"),
        ("当前活动与赠品", "D13 / K21", "「以页面为准」", "有赠品就写清送什么、送完即止"),
        ("保价 / 降价补差规则", "D10", "「有保价规则可以申请」", "确认是否支持、几天内、怎么申请"),
        ("港澳台与海外是否发货", "F26", "「以页面可选地址为准」", "确认后直接说能或不能"),
        ("9.9 元是否是长期价", "D01", "「这款现在 9.9 元」", "价格调整时同步改表，避免报错价"),
        ("85% 发芽率适用的品种范围", "C01 / C14", "「常规品种 85% 以上」", "写清哪些品种、哪些批次，别一锅端"),
        ("是否可开「有机」相关证明", "A07", "「没有走有机认证」", "确认后要么补证，要么保持现状"),
    ]
    r = 4
    for i, (fact, rows_, now, after) in enumerate(items, 1):
        ws.cell(row=r, column=1, value=f"T{i:02d}")
        ws.cell(row=r, column=2, value=fact)
        ws.cell(row=r, column=3, value=rows_)
        ws.cell(row=r, column=4, value=now)
        ws.cell(row=r, column=5, value=after)
        ws.cell(row=r, column=6, value="待确认")
        for col in range(1, ncols + 1):
            style_cell(ws.cell(row=r, column=col), size=9.5, bold=(col == 2),
                       align="center" if col in (1, 3, 6) else "left",
                       fill=WHITE if i % 2 else GRAY,
                       color="8A5A00" if col == 6 else INK)
        ws.row_dimensions[r].height = row_height([fact, now, after], [widths[1], widths[3], widths[4]], 9.5)
        r += 1

    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0


def main():
    rows = load_rows()
    validate(rows)
    main_rows = [r for r in rows if not r["id"].startswith("K")]
    appx_rows = [r for r in rows if r["id"].startswith("K")]

    wb = Workbook()
    build_method_sheet(wb)
    build_table_sheet(
        wb,
        "拼多多客服 200 问：建议回复与边界",
        "按分类筛选。先看 G 列处理方式：🟢 直接答 / 🟡 核对后答 / 🔴 转主管；"
        "标黄的处理方式先核对 H 列再发；I 列是常见错法。价格、库存为示例，发前看页面。",
        main_rows, "② 200问总表")
    build_table_sheet(
        wb,
        "附录：换类目也能用的 30 条",
        "服装、食品、3C、美妆、家居母婴各 6 条。换类目时，把商品事实换掉，判断方法不变。",
        appx_rows, "③ 附录30问")
    build_stats_sheet(wb, main_rows)
    build_todo_sheet(wb)

    wb.properties.title = "拼多多客服 200 问：建议回复与边界"
    wb.properties.subject = "客服培训与日常查询"
    wb.properties.creator = "pdd-cs-assistant"
    wb.properties.description = "200 条主表 + 30 条跨类目附录；含回复方法、分类计划、待确认店铺事实。"

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    wb.save(OUT)
    print("已生成", OUT)


if __name__ == "__main__":
    main()
