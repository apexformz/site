"""Rasterize a Word-exported QA PDF with the bundled Poppler runtime."""
import argparse
import json
from pathlib import Path
from pdf2image import convert_from_path, pdfinfo_from_path

parser = argparse.ArgumentParser()
parser.add_argument("pdf")
parser.add_argument("output_dir")
parser.add_argument("--dpi", type=int, default=150)
args = parser.parse_args()
poppler = Path(r"C:\Users\ASUS\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin")
out = Path(args.output_dir)
out.mkdir(parents=True, exist_ok=True)
info = pdfinfo_from_path(args.pdf, poppler_path=str(poppler))
paths = []
for i in range(1, int(info["Pages"]) + 1):
    page = convert_from_path(args.pdf, dpi=args.dpi, first_page=i, last_page=i, poppler_path=str(poppler))[0]
    path = out / f"page-{i}.png"
    page.save(path)
    paths.append(str(path.resolve()))
print(json.dumps({"pages": len(paths), "dpi": args.dpi, "images": paths}))
