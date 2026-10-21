"""Validation against api/openapi.yaml, the single schema source shared by every service."""

from functools import cache
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

OPENAPI_PATH = Path(__file__).resolve().parents[3] / "api" / "openapi.yaml"
_URI = "urn:contract"


@cache
def _registry() -> Registry:
    doc = yaml.safe_load(OPENAPI_PATH.read_text())
    return Registry().with_resource(_URI, Resource.from_contents(doc, default_specification=DRAFT202012))


@cache
def validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(
        {"$ref": f"{_URI}#/components/schemas/{name}"},
        registry=_registry(),
        format_checker=FormatChecker(),
    )


def errors(name: str, instance) -> list[str]:
    """Human-readable validation errors, empty when the instance is valid."""
    return [
        f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}"
        for e in sorted(validator(name).iter_errors(instance), key=lambda e: list(e.absolute_path))
    ]


class ContractViolation(Exception):
    def __init__(self, name: str, problems: list[str]):
        super().__init__(f"{name} violates contract: {problems}")
        self.name = name
        self.problems = problems


def check(name: str, instance):
    """Raise if the instance does not match the named schema; return it otherwise."""
    if problems := errors(name, instance):
        raise ContractViolation(name, problems)
    return instance
