"""Generated service module 387 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-387"

@dataclass
class Record387:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_387(items: Iterable[Mapping[str, int]]) -> list[Record387]:
    output: list[Record387] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 387
        output.append(Record387(key=f"387-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_387(records: list[Record387]) -> dict[str, int]:
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

def route_387(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_387([payload])
    return summarize_387(records)

def helper_387_00(seed: int) -> int:
    acc = seed + 387 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_387_01(seed: int) -> int:
    acc = seed + 387 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_387_02(seed: int) -> int:
    acc = seed + 387 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_387_03(seed: int) -> int:
    acc = seed + 387 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_387_04(seed: int) -> int:
    acc = seed + 387 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_387_05(seed: int) -> int:
    acc = seed + 387 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_387_06(seed: int) -> int:
    acc = seed + 387 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

