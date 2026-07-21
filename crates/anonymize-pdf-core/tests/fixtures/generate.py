"""Generate public, synthetic PDF inspection fixtures deterministically.

Run with:
uv run --isolated --no-project --with pillow==12.3.0 --with pypdf==6.14.2 \
  --with reportlab==5.0.0 python generate.py
"""

from pathlib import Path

from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    TextStringObject,
)
from reportlab.pdfgen.canvas import Canvas


FIXTURE_DIRECTORY = Path(__file__).parent


def minimal_text() -> None:
    output = FIXTURE_DIRECTORY / "minimal-text.pdf"
    canvas = Canvas(str(output), pagesize=(612, 792), invariant=1)
    canvas.setTitle("Public PDF inspection fixture")
    canvas.setAuthor("stella anonymize tests")
    canvas.drawString(72, 720, "Public fixture: Alice Example signed.")
    canvas.showPage()
    canvas.save()


def risky_structures() -> None:
    base = FIXTURE_DIRECTORY / "risky-structures.base.pdf"
    pixel = FIXTURE_DIRECTORY / "public-pixel.png"
    Image.new("RGB", (2, 2), color=(80, 120, 160)).save(pixel)

    canvas = Canvas(str(base), pagesize=(612, 792), invariant=1)
    canvas.setTitle("Synthetic risky-structure fixture")
    canvas.drawString(72, 720, "Synthetic PDF inspection fixture")
    canvas.drawImage(str(pixel), 72, 650, width=24, height=24)
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
    writer.add_attachment("public-note.txt", b"Synthetic attachment fixture")
    writer.add_js("app.alert('Synthetic fixture');")
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
        resolved_form[NameObject("/Fields")].append(
            writer._add_object(signature_field)
        )

    with (FIXTURE_DIRECTORY / "risky-structures.pdf").open("wb") as output:
        writer.write(output)
    base.unlink()
    pixel.unlink()


if __name__ == "__main__":
    minimal_text()
    risky_structures()
