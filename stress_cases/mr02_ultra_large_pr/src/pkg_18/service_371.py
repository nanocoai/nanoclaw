"""Generated service module 371 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-371"

@dataclass
class Record371:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_371(items: Iterable[Mapping[str, int]]) -> list[Record371]:
    output: list[Record371] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 371
        output.append(Record371(key=f"371-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_371(records: list[Record371]) -> dict[str, int]:
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

def route_371(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_371([payload])
    return summarize_371(records)

def helper_371_00(seed: int) -> int:
    acc = seed + 371 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_371_01(seed: int) -> int:
    acc = seed + 371 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_371_02(seed: int) -> int:
    acc = seed + 371 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_371_03(seed: int) -> int:
    acc = seed + 371 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_371_04(seed: int) -> int:
    acc = seed + 371 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_371_05(seed: int) -> int:
    acc = seed + 371 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_371_06(seed: int) -> int:
    acc = seed + 371 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

