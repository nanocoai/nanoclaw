"""Generated service module 313 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-313"

@dataclass
class Record313:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_313(items: Iterable[Mapping[str, int]]) -> list[Record313]:
    output: list[Record313] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 313
        output.append(Record313(key=f"313-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_313(records: list[Record313]) -> dict[str, int]:
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

def route_313(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_313([payload])
    return summarize_313(records)

def helper_313_00(seed: int) -> int:
    acc = seed + 313 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_313_01(seed: int) -> int:
    acc = seed + 313 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_313_02(seed: int) -> int:
    acc = seed + 313 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_313_03(seed: int) -> int:
    acc = seed + 313 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_313_04(seed: int) -> int:
    acc = seed + 313 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_313_05(seed: int) -> int:
    acc = seed + 313 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_313_06(seed: int) -> int:
    acc = seed + 313 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

