"""Generated service module 136 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-136"

@dataclass
class Record136:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_136(items: Iterable[Mapping[str, int]]) -> list[Record136]:
    output: list[Record136] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 136
        output.append(Record136(key=f"136-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_136(records: list[Record136]) -> dict[str, int]:
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

def route_136(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_136([payload])
    return summarize_136(records)

def helper_136_00(seed: int) -> int:
    acc = seed + 136 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_136_01(seed: int) -> int:
    acc = seed + 136 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_136_02(seed: int) -> int:
    acc = seed + 136 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_136_03(seed: int) -> int:
    acc = seed + 136 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_136_04(seed: int) -> int:
    acc = seed + 136 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_136_05(seed: int) -> int:
    acc = seed + 136 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_136_06(seed: int) -> int:
    acc = seed + 136 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

