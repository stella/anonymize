"""Generate public, synthetic PDF inspection fixtures deterministically.

Run with:
uv run --isolated --no-project --with pillow==12.3.0 --with pypdf==6.14.2 \
  --with reportlab==5.0.0 python generate.py
"""

import json
from pathlib import Path

from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    ByteStringObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    TextStringObject,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import ImageReader


FIXTURE_DIRECTORY = Path(__file__).parent
MINIMAL_TEXT = "Public fixture: Alice Example signed."
MINIMAL_FONT_NAME = "Helvetica"
MINIMAL_FONT_SIZE = 12
MINIMAL_TEXT_LEFT = 72
MINIMAL_TEXT_BASELINE = 720
RISKY_DOCUMENT_ID = b"public-risk-pdf!"
ENCRYPTED_DOCUMENT_ID = b"public-pdf-test!"


def set_deterministic_id(writer: PdfWriter, identifier: bytes) -> None:
    if len(identifier) != 16:
        raise ValueError("PDF fixture identifiers must contain exactly 16 bytes")
    pdf_identifier = ByteStringObject(identifier)
    writer._ID = ArrayObject([pdf_identifier, pdf_identifier])


def minimal_text() -> None:
    output = FIXTURE_DIRECTORY / "minimal-text.pdf"
    canvas = Canvas(str(output), pagesize=(612, 792), invariant=1)
    canvas.setTitle("Public PDF inspection fixture")
    canvas.setAuthor("stella anonymize tests")
    canvas.setFont(MINIMAL_FONT_NAME, MINIMAL_FONT_SIZE)
    canvas.drawString(MINIMAL_TEXT_LEFT, MINIMAL_TEXT_BASELINE, MINIMAL_TEXT)
    canvas.showPage()
    canvas.save()

    face = pdfmetrics.getFont(MINIMAL_FONT_NAME).face
    width = pdfmetrics.stringWidth(MINIMAL_TEXT, MINIMAL_FONT_NAME, MINIMAL_FONT_SIZE)
    observation = {
        "pageIndex": 0,
        "widthPoints": 612,
        "heightPoints": 792,
        "text": MINIMAL_TEXT,
        "glyphs": [
            {
                "start": 0,
                "end": len(MINIMAL_TEXT.encode("utf-16-le")) // 2,
                "bounds": {
                    "left": MINIMAL_TEXT_LEFT,
                    "bottom": MINIMAL_TEXT_BASELINE
                    + MINIMAL_FONT_SIZE * face.descent / 1000,
                    "right": MINIMAL_TEXT_LEFT + width,
                    "top": MINIMAL_TEXT_BASELINE
                    + MINIMAL_FONT_SIZE * face.ascent / 1000,
                },
                "source": "embedded-text",
            }
        ],
        "rendered": True,
        "textLayer": "complete",
        "ocr": "complete",
        "imageCount": 0,
    }
    (FIXTURE_DIRECTORY / "minimal-text-observation.json").write_text(
        json.dumps(observation, indent=2) + "\n", encoding="utf-8"
    )


def risky_structures() -> None:
    base = FIXTURE_DIRECTORY / "risky-structures.base.pdf"
    pixel = ImageReader(Image.new("RGB", (2, 2), color=(80, 120, 160)))

    canvas = Canvas(str(base), pagesize=(612, 792), invariant=1)
    canvas.setTitle("Synthetic risky-structure fixture")
    canvas.drawString(72, 720, "Synthetic PDF inspection fixture")
    canvas.drawImage(pixel, 72, 650, width=24, height=24)
    canvas.linkURL("https://example.invalid/public", (72, 620, 240, 640))
    canvas.acroForm.textfield(
        name="public_fixture_field",
        value="Synthetic form value",
        x=72,
        y=570,
        width=180,
        height=20,
    )
    canvas.showPage()
    canvas.save()

    reader = PdfReader(base)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    set_deterministic_id(writer, RISKY_DOCUMENT_ID)
    writer.add_attachment("public-note.txt", b"Synthetic attachment fixture")
    javascript_action = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Action"),
            NameObject("/S"): NameObject("/JavaScript"),
            NameObject("/JS"): TextStringObject("app.alert('Synthetic fixture');"),
        }
    )
    names = writer.root_object[NameObject("/Names")].get_object()
    names[NameObject("/JavaScript")] = DictionaryObject(
        {
            NameObject("/Names"): ArrayObject(
                [
                    TextStringObject("public_fixture_javascript"),
                    writer._add_object(javascript_action),
                ]
            )
        }
    )
    writer.add_metadata(
        {
            "/Title": "Synthetic risky-structure fixture",
            "/Author": "stella anonymize tests",
            "/Subject": "Public fixture only",
        }
    )

    metadata = DecodedStreamObject()
    metadata.set_data(b"<x:xmpmeta xmlns:x='adobe:ns:meta/'/>")
    metadata[NameObject("/Type")] = NameObject("/Metadata")
    metadata[NameObject("/Subtype")] = NameObject("/XML")
    writer.root_object[NameObject("/Metadata")] = writer._add_object(metadata)

    optional_group = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/OCG"),
            NameObject("/Name"): TextStringObject("Synthetic optional layer"),
        }
    )
    optional_group_reference = writer._add_object(optional_group)
    writer.root_object[NameObject("/OCProperties")] = DictionaryObject(
        {
            NameObject("/OCGs"): ArrayObject([optional_group_reference]),
            NameObject("/D"): DictionaryObject(
                {NameObject("/Order"): ArrayObject([optional_group_reference])}
            ),
        }
    )

    acro_form = writer.root_object.get("/AcroForm")
    if acro_form is not None:
        resolved_form = acro_form.get_object()
        xfa = DecodedStreamObject()
        xfa.set_data(b"<xfa>Public synthetic inventory marker</xfa>")
        resolved_form[NameObject("/XFA")] = writer._add_object(xfa)
        signature_field = DictionaryObject(
            {
                NameObject("/FT"): NameObject("/Sig"),
                NameObject("/T"): TextStringObject("public_fixture_signature"),
            }
        )
        resolved_form[NameObject("/Fields")].append(writer._add_object(signature_field))

    with (FIXTURE_DIRECTORY / "risky-structures.pdf").open("wb") as output:
        writer.write(output)
    base.unlink()


def encrypted_document() -> None:
    reader = PdfReader(FIXTURE_DIRECTORY / "minimal-text.pdf")
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    set_deterministic_id(writer, ENCRYPTED_DOCUMENT_ID)
    writer.encrypt(
        "public-password",
        owner_password="public-owner-password",
        algorithm="RC4-40",
    )
    with (FIXTURE_DIRECTORY / "encrypted.pdf").open("wb") as output:
        writer.write(output)


if __name__ == "__main__":
    minimal_text()
    risky_structures()
    encrypted_document()
