"""Generated service module 107 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-107"

@dataclass
class Record107:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_107(items: Iterable[Mapping[str, int]]) -> list[Record107]:
    output: list[Record107] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 107
        output.append(Record107(key=f"107-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_107(records: list[Record107]) -> dict[str, int]:
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

def route_107(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_107([payload])
    return summarize_107(records)

def helper_107_00(seed: int) -> int:
    acc = seed + 107 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_107_01(seed: int) -> int:
    acc = seed + 107 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_107_02(seed: int) -> int:
    acc = seed + 107 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_107_03(seed: int) -> int:
    acc = seed + 107 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_107_04(seed: int) -> int:
    acc = seed + 107 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_107_05(seed: int) -> int:
    acc = seed + 107 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_107_06(seed: int) -> int:
    acc = seed + 107 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

