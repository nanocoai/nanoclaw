"""Generated service module 417 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-417"

@dataclass
class Record417:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_417(items: Iterable[Mapping[str, int]]) -> list[Record417]:
    output: list[Record417] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 417
        output.append(Record417(key=f"417-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_417(records: list[Record417]) -> dict[str, int]:
    total = 0
    maximum = None
    minimum = None
    for record in records:
        total += record.value
        maximum = record.value if maximum is None else max(maximum, record.value)
        minimum = record.value if minimum is None else min(minimum, record.value)
    return {
        "count": len(records),
        "total": total,
        "maximum": maximum or 0,
        "minimum": minimum or 0,
    }

def route_417(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_417([payload])
    return summarize_417(records)

def helper_417_00(seed: int) -> int:
    acc = seed + 417 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_417_01(seed: int) -> int:
    acc = seed + 417 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_417_02(seed: int) -> int:
    acc = seed + 417 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_417_03(seed: int) -> int:
    acc = seed + 417 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_417_04(seed: int) -> int:
    acc = seed + 417 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_417_05(seed: int) -> int:
    acc = seed + 417 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_417_06(seed: int) -> int:
    acc = seed + 417 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

