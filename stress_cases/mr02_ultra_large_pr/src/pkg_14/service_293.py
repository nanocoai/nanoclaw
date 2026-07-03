"""Generated service module 293 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-293"

@dataclass
class Record293:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_293(items: Iterable[Mapping[str, int]]) -> list[Record293]:
    output: list[Record293] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 293
        output.append(Record293(key=f"293-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_293(records: list[Record293]) -> dict[str, int]:
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

def route_293(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_293([payload])
    return summarize_293(records)

def helper_293_00(seed: int) -> int:
    acc = seed + 293 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_293_01(seed: int) -> int:
    acc = seed + 293 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_293_02(seed: int) -> int:
    acc = seed + 293 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_293_03(seed: int) -> int:
    acc = seed + 293 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_293_04(seed: int) -> int:
    acc = seed + 293 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_293_05(seed: int) -> int:
    acc = seed + 293 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_293_06(seed: int) -> int:
    acc = seed + 293 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

