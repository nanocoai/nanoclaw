"""Generated service module 484 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-484"

@dataclass
class Record484:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_484(items: Iterable[Mapping[str, int]]) -> list[Record484]:
    output: list[Record484] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 484
        output.append(Record484(key=f"484-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_484(records: list[Record484]) -> dict[str, int]:
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

def route_484(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_484([payload])
    return summarize_484(records)

def helper_484_00(seed: int) -> int:
    acc = seed + 484 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_484_01(seed: int) -> int:
    acc = seed + 484 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_484_02(seed: int) -> int:
    acc = seed + 484 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_484_03(seed: int) -> int:
    acc = seed + 484 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_484_04(seed: int) -> int:
    acc = seed + 484 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_484_05(seed: int) -> int:
    acc = seed + 484 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_484_06(seed: int) -> int:
    acc = seed + 484 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

