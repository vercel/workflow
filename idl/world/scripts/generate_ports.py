#!/usr/bin/env python3
"""Emit language port interfaces from the built Smithy model.

Two gaps in the upstream tooling make this script necessary:

* ``smithy-typescript`` types mode generates data shapes only, so nothing
  declares the operations themselves. This emits the per-service interface
  that an in-process implementation satisfies, on top of the generated types.
* ``smithy-python`` has no published release, so there is nothing to run for
  Python at all. This emits the equivalent dataclasses, enums, errors, and
  Protocol interfaces directly from the model.

Both outputs are transport-free on purpose: they are plain function shapes
over generated types, with no serialization, client, or endpoint concerns.

Usage:
    generate_ports.py <model.json> <typescript-out-dir> <python-out-dir>
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

NAMESPACE = "vercel.workflow.world"
PRELUDE = "smithy.api#"

DOC = f"{PRELUDE}documentation"
REQUIRED = f"{PRELUDE}required"
ERROR = f"{PRELUDE}error"
SPARSE = f"{PRELUDE}sparse"
STREAMING = f"{PRELUDE}streaming"
ENUM_VALUE = f"{PRELUDE}enumValue"
LOCAL_ONLY = f"{NAMESPACE}#localOnly"
OPTIONAL_CAPABILITY = f"{NAMESPACE}#optionalCapability"
CALLBACK = f"{NAMESPACE}#callback"

GENERATED_HEADER = "Generated from the Smithy model. Do not edit by hand."

TS_SCALARS = {
    "string": "string",
    "integer": "number",
    "long": "number",
    "float": "number",
    "double": "number",
    "boolean": "boolean",
    "blob": "Uint8Array",
    "timestamp": "Date",
    "document": "unknown",
}

PY_SCALARS = {
    "string": "str",
    "integer": "int",
    "long": "int",
    "float": "float",
    "double": "float",
    "boolean": "bool",
    "blob": "bytes",
    "timestamp": "datetime",
    "document": "Any",
}


class Model:
    def __init__(self, raw: dict[str, Any]) -> None:
        self.shapes: dict[str, Any] = raw["shapes"]

    def get(self, shape_id: str) -> dict[str, Any]:
        return self.shapes[shape_id]

    def local(self, kinds: tuple[str, ...]) -> list[str]:
        found = [
            shape_id
            for shape_id, shape in self.shapes.items()
            if shape_id.startswith(f"{NAMESPACE}#") and shape["type"] in kinds
        ]
        return sorted(found, key=name_of)

    def services(self) -> list[str]:
        return self.local(("service",))

    def traits(self, shape_id: str) -> dict[str, Any]:
        return self.get(shape_id).get("traits", {})

    def doc(self, shape_id: str) -> str | None:
        return self.traits(shape_id).get(DOC)


def name_of(shape_id: str) -> str:
    return shape_id.split("#", 1)[1]


def member_doc(member: dict[str, Any]) -> str | None:
    return member.get("traits", {}).get(DOC)


def is_required(member: dict[str, Any]) -> bool:
    return REQUIRED in member.get("traits", {})


def camel(name: str) -> str:
    return name[0].lower() + name[1:] if name else name


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def screaming(name: str) -> str:
    """Enum member names are already SCREAMING_CASE in the model."""
    if re.fullmatch(r"[A-Z0-9_]+", name):
        return name
    return snake(name).upper()


def paragraphs(text: str) -> list[str]:
    """Rejoins hard-wrapped source lines into logical paragraphs."""
    result: list[str] = []
    current: list[str] = []
    for line in text.strip().split("\n"):
        stripped = line.strip()
        if stripped:
            current.append(stripped)
        elif current:
            result.append(" ".join(current))
            current = []
    if current:
        result.append(" ".join(current))
    return result


def wrap(text: str, width: int = 72) -> list[str]:
    lines: list[str] = []
    for index, paragraph in enumerate(paragraphs(text)):
        if index:
            lines.append("")
        current = ""
        for word in paragraph.split():
            candidate = f"{current} {word}".strip()
            if len(candidate) > width and current:
                lines.append(current)
                current = word
            else:
                current = candidate
        if current:
            lines.append(current)
    while lines and not lines[-1]:
        lines.pop()
    return lines


def ts_doc(text: str | None, indent: str) -> list[str]:
    if not text:
        return []
    out = [f"{indent}/**"]
    for line in wrap(text):
        out.append(f"{indent} *{f' {line}' if line else ''}")
    out.append(f"{indent} */")
    return out


def py_doc(text: str | None, indent: str) -> list[str]:
    if not text:
        return []
    lines = wrap(text)
    if len(lines) == 1:
        return [f'{indent}"""{lines[0]}"""']
    out = [f'{indent}"""{lines[0]}']
    out.extend(f"{indent}{line}" if line else "" for line in lines[1:])
    out.append(f'{indent}"""')
    return out


class TypeResolver:
    """Maps Smithy shape targets onto language types."""

    def __init__(self, model: Model, scalars: dict[str, str], language: str) -> None:
        self.model = model
        self.scalars = scalars
        self.language = language

    def resolve(self, target: str) -> str:
        if target.startswith(PRELUDE):
            kind = name_of(target).lower()
            if kind == "unit":
                return "void" if self.language == "ts" else "None"
            return self.scalars[kind]

        shape = self.model.get(target)
        kind = shape["type"]

        if kind in ("structure", "union", "enum", "intEnum"):
            return name_of(target)

        # Aliases of simple types keep their generated alias name so the
        # domain vocabulary (RunId, Cursor, SerializedData) survives codegen.
        if kind == "blob" and STREAMING in shape.get("traits", {}):
            return name_of(target)
        if kind in self.scalars:
            return name_of(target)
        if kind in ("list", "map"):
            return name_of(target)

        raise ValueError(f"unsupported shape type {kind} for {target}")


def collect_shapes(model: Model) -> dict[str, list[str]]:
    return {
        "structures": [s for s in model.local(("structure",)) if ERROR not in model.traits(s)],
        "errors": [s for s in model.local(("structure",)) if ERROR in model.traits(s)],
        "unions": model.local(("union",)),
        "enums": model.local(("enum",)),
        "lists": model.local(("list",)),
        "maps": model.local(("map",)),
        "aliases": [
            s
            for s in model.local(tuple(TS_SCALARS.keys()))
            if s.startswith(f"{NAMESPACE}#")
        ],
    }


def operation_signature(model: Model, operation_id: str) -> tuple[str | None, str | None]:
    operation = model.get(operation_id)
    input_target = operation.get("input", {}).get("target")
    output_target = operation.get("output", {}).get("target")
    return (
        None if not input_target or input_target.endswith("#Unit") else input_target,
        None if not output_target or output_target.endswith("#Unit") else output_target,
    )


def operation_notes(model: Model, operation_id: str) -> list[str]:
    traits = model.traits(operation_id)
    notes = []
    if LOCAL_ONLY in traits:
        notes.append("Local only: never exposed over a transport.")
    if CALLBACK in traits:
        notes.append("Callback: implemented by the runtime, called by the World.")
    capability = traits.get(OPTIONAL_CAPABILITY)
    if capability:
        notes.append(f"Optional capability: `{capability['name']}`.")
    errors = [name_of(e["target"]) for e in model.get(operation_id).get("errors", [])]
    if errors:
        notes.append("Throws: " + ", ".join(sorted(errors)) + ".")
    return notes


def render_typescript_ports(model: Model) -> str:
    resolver = TypeResolver(model, TS_SCALARS, "ts")
    imported: set[str] = set()
    body: list[str] = []

    for service_id in model.services():
        service = model.get(service_id)
        operations = sorted(
            (op["target"] for op in service.get("operations", [])), key=name_of
        )
        interface = f"{name_of(service_id)}Port"

        body.append("")
        doc = model.doc(service_id)
        combined = doc or ""
        body.extend(ts_doc(combined, ""))
        body.append(f"export interface {interface} {{")

        for index, operation_id in enumerate(operations):
            input_target, output_target = operation_signature(model, operation_id)
            input_type = resolver.resolve(input_target) if input_target else None
            output_type = resolver.resolve(output_target) if output_target else "void"
            for candidate in (input_type, output_type):
                if candidate and candidate != "void":
                    imported.add(candidate)

            doc_text = model.doc(operation_id) or ""
            notes = operation_notes(model, operation_id)
            if notes:
                doc_text = (doc_text + "\n\n" + "\n".join(notes)).strip()
            if index:
                body.append("")
            body.extend(ts_doc(doc_text, "  "))
            argument = f"input: {input_type}" if input_type else ""
            body.append(f"  {camel(name_of(operation_id))}({argument}): Promise<{output_type}>;")

        body.append("}")

    header = [
        f"// {GENERATED_HEADER}",
        "// Source: idl/world/model, emitted by idl/world/scripts/generate_ports.py",
        "",
        "import type {",
    ]
    header.extend(f"  {name}," for name in sorted(imported))
    header.extend(["} from './models/models_0';"])
    return "\n".join(header + body) + "\n"


def python_member_type(resolver: TypeResolver, member: dict[str, Any]) -> str:
    return resolver.resolve(member["target"])


def render_python_models(model: Model) -> str:
    resolver = TypeResolver(model, PY_SCALARS, "py")
    shapes = collect_shapes(model)
    out: list[str] = [
        f'"""{GENERATED_HEADER}',
        "",
        "Source: idl/world/model, emitted by idl/world/scripts/generate_ports.py",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from dataclasses import dataclass",
        "from datetime import datetime",
        "from enum import Enum",
        "from typing import Any, AsyncIterable, Optional, Union",
        "",
        "from ._base import WorldError",
        "",
    ]

    for shape_id in shapes["aliases"]:
        shape = model.get(shape_id)
        kind = shape["type"]
        name = name_of(shape_id)
        if kind == "blob" and STREAMING in shape.get("traits", {}):
            target = "AsyncIterable[bytes]"
        else:
            target = PY_SCALARS[kind]
        out.append("")
        out.extend(py_doc(model.doc(shape_id), ""))
        out.append(f"{name} = {target}")

    for shape_id in shapes["enums"]:
        shape = model.get(shape_id)
        out.extend(["", "", f"class {name_of(shape_id)}(str, Enum):"])
        doc = py_doc(model.doc(shape_id), "    ")
        out.extend(doc if doc else [])
        for member_name, member in shape["members"].items():
            value = member.get("traits", {}).get(ENUM_VALUE, member_name)
            member_docs = py_doc(member_doc(member), "    ")
            if member_docs:
                out.extend(member_docs)
            out.append(f'    {screaming(member_name)} = "{value}"')

    for shape_id in shapes["lists"]:
        shape = model.get(shape_id)
        inner = resolver.resolve(shape["member"]["target"])
        if SPARSE in shape.get("traits", {}):
            inner = f"Optional[{inner}]"
        out.extend(["", f'{name_of(shape_id)} = list["{inner}"]'])

    for shape_id in shapes["maps"]:
        shape = model.get(shape_id)
        key = resolver.resolve(shape["key"]["target"])
        value = resolver.resolve(shape["value"]["target"])
        if SPARSE in shape.get("traits", {}):
            value = f"Optional[{value}]"
        out.extend(["", f'{name_of(shape_id)} = dict["{key}", "{value}"]'])

    for shape_id in shapes["structures"]:
        out.extend(render_python_dataclass(model, resolver, shape_id))

    for shape_id in shapes["unions"]:
        out.extend(render_python_union(model, resolver, shape_id))

    for shape_id in shapes["errors"]:
        out.extend(render_python_error(model, resolver, shape_id))

    return "\n".join(out) + "\n"


def python_fields(
    model: Model, resolver: TypeResolver, shape_id: str, indent: str = "    "
) -> list[str]:
    shape = model.get(shape_id)
    members = shape.get("members", {})
    if not members:
        return []

    required = [(n, m) for n, m in members.items() if is_required(m)]
    optional = [(n, m) for n, m in members.items() if not is_required(m)]
    lines: list[str] = []

    for member_name, member in required:
        annotation = python_member_type(resolver, member)
        lines.append(f'{indent}{snake(member_name)}: "{annotation}"')
        lines.extend(py_doc(member_doc(member), indent))

    for member_name, member in optional:
        annotation = python_member_type(resolver, member)
        lines.append(f'{indent}{snake(member_name)}: "Optional[{annotation}]" = None')
        lines.extend(py_doc(member_doc(member), indent))

    return lines


def render_python_dataclass(model: Model, resolver: TypeResolver, shape_id: str) -> list[str]:
    out = ["", "", "@dataclass", f"class {name_of(shape_id)}:"]
    doc = py_doc(model.doc(shape_id), "    ")
    if doc:
        out.extend(doc)
    fields = python_fields(model, resolver, shape_id)
    if fields:
        if doc:
            out.append("")
        out.extend(fields)
    elif not doc:
        out.append("    pass")
    return out


def render_python_union(model: Model, resolver: TypeResolver, shape_id: str) -> list[str]:
    shape = model.get(shape_id)
    union_name = name_of(shape_id)
    out: list[str] = []
    variants: list[str] = []

    for member_name, member in shape["members"].items():
        variant = f"{union_name}{member_name[0].upper()}{member_name[1:]}"
        variants.append(variant)
        annotation = python_member_type(resolver, member)
        out.extend(["", "", "@dataclass", f"class {variant}:"])
        docs = py_doc(member_doc(member), "    ")
        if docs:
            out.extend(docs)
            out.append("")
        out.append(f'    value: "{annotation}"')

    out.append("")
    out.extend(py_doc(model.doc(shape_id), ""))
    joined = ", ".join(f'"{variant}"' for variant in variants)
    out.append(f"{union_name} = Union[{joined}]")
    return out


def render_python_error(model: Model, resolver: TypeResolver, shape_id: str) -> list[str]:
    out = ["", "", "@dataclass", f"class {name_of(shape_id)}(WorldError):"]
    doc = py_doc(model.doc(shape_id), "    ")
    if doc:
        out.extend(doc)
    fields = python_fields(model, resolver, shape_id)
    if fields:
        if doc:
            out.append("")
        out.extend(fields)
    return out


def render_python_ports(model: Model) -> str:
    resolver = TypeResolver(model, PY_SCALARS, "py")
    imported: set[str] = set()
    body: list[str] = []

    for service_id in model.services():
        service = model.get(service_id)
        operations = sorted(
            (op["target"] for op in service.get("operations", [])), key=name_of
        )
        body.extend(["", "", f"class {name_of(service_id)}Port(Protocol):"])
        doc = py_doc(model.doc(service_id), "    ")
        if doc:
            body.extend(doc)

        for operation_id in operations:
            input_target, output_target = operation_signature(model, operation_id)
            input_type = resolver.resolve(input_target) if input_target else None
            output_type = resolver.resolve(output_target) if output_target else "None"
            for candidate in (input_type, output_type):
                if candidate and candidate != "None":
                    imported.add(candidate)

            doc_text = model.doc(operation_id) or ""
            notes = operation_notes(model, operation_id)
            if notes:
                doc_text = (doc_text + "\n\n" + "\n".join(notes)).strip()

            argument = f', input: "{input_type}"' if input_type else ""
            body.append("")
            body.append(
                f'    async def {snake(name_of(operation_id))}(self{argument}) -> "{output_type}": ...'
            )
            operation_docs = py_doc(doc_text, "        ")
            if operation_docs:
                body[-1] = body[-1].removesuffix(" ...")
                body.extend(operation_docs)
                body.append("        ...")

    header = [
        f'"""{GENERATED_HEADER}',
        "",
        "Source: idl/world/model, emitted by idl/world/scripts/generate_ports.py",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from typing import Protocol",
        "",
        "from .models import (",
    ]
    header.extend(f"    {name}," for name in sorted(imported))
    header.append(")")
    return "\n".join(header + body) + "\n"


def render_python_init(model: Model) -> str:
    return "\n".join(
        [
            f'"""{GENERATED_HEADER}"""',
            "",
            "from .models import *  # noqa: F401,F403",
            "from .ports import *  # noqa: F401,F403",
            "",
        ]
    )


def render_python_base() -> str:
    return "\n".join(
        [
            '"""Hand-written base types the generated modules build on."""',
            "",
            "from __future__ import annotations",
            "",
            "",
            "class WorldError(Exception):",
            '    """Base class for every modeled World error."""',
            "",
        ]
    )


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2

    model_path, ts_dir, py_dir = (Path(arg) for arg in sys.argv[1:])
    model = Model(json.loads(model_path.read_text()))

    ts_dir.mkdir(parents=True, exist_ok=True)
    (ts_dir / "ports.ts").write_text(render_typescript_ports(model))

    py_dir.mkdir(parents=True, exist_ok=True)
    (py_dir / "__init__.py").write_text(render_python_init(model))
    (py_dir / "_base.py").write_text(render_python_base())
    (py_dir / "models.py").write_text(render_python_models(model))
    (py_dir / "ports.py").write_text(render_python_ports(model))

    print(f"wrote {ts_dir / 'ports.ts'}")
    print(f"wrote {py_dir / 'models.py'}")
    print(f"wrote {py_dir / 'ports.py'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
