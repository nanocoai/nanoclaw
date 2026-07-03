"""Generated service module 414 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-414"

@dataclass
class Record414:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_414(items: Iterable[Mapping[str, int]]) -> list[Record414]:
    output: list[Record414] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 414
        output.append(Record414(key=f"414-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_414(records: list[Record414]) -> dict[str, int]:
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

def route_414(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_414([payload])
    return summarize_414(records)

def helper_414_00(seed: int) -> int:
    acc = seed + 414 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_414_01(seed: int) -> int:
    acc = seed + 414 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_414_02(seed: int) -> int:
    acc = seed + 414 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_414_03(seed: int) -> int:
    acc = seed + 414 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_414_04(seed: int) -> int:
    acc = seed + 414 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_414_05(seed: int) -> int:
    acc = seed + 414 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_414_06(seed: int) -> int:
    acc = seed + 414 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

