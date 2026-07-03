"""Generated service module 087 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-087"

@dataclass
class Record087:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_087(items: Iterable[Mapping[str, int]]) -> list[Record087]:
    output: list[Record087] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 87
        output.append(Record087(key=f"087-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_087(records: list[Record087]) -> dict[str, int]:
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

def route_087(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_087([payload])
    return summarize_087(records)

def helper_087_00(seed: int) -> int:
    acc = seed + 87 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_087_01(seed: int) -> int:
    acc = seed + 87 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_087_02(seed: int) -> int:
    acc = seed + 87 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_087_03(seed: int) -> int:
    acc = seed + 87 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_087_04(seed: int) -> int:
    acc = seed + 87 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_087_05(seed: int) -> int:
    acc = seed + 87 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_087_06(seed: int) -> int:
    acc = seed + 87 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

