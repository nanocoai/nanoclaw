"""Generated service module 251 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-251"

@dataclass
class Record251:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_251(items: Iterable[Mapping[str, int]]) -> list[Record251]:
    output: list[Record251] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 251
        output.append(Record251(key=f"251-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_251(records: list[Record251]) -> dict[str, int]:
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

def route_251(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_251([payload])
    return summarize_251(records)

def helper_251_00(seed: int) -> int:
    acc = seed + 251 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_251_01(seed: int) -> int:
    acc = seed + 251 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_251_02(seed: int) -> int:
    acc = seed + 251 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_251_03(seed: int) -> int:
    acc = seed + 251 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_251_04(seed: int) -> int:
    acc = seed + 251 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_251_05(seed: int) -> int:
    acc = seed + 251 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_251_06(seed: int) -> int:
    acc = seed + 251 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

