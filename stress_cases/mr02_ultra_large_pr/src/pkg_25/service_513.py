"""Generated service module 513 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-513"

@dataclass
class Record513:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_513(items: Iterable[Mapping[str, int]]) -> list[Record513]:
    output: list[Record513] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 513
        output.append(Record513(key=f"513-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_513(records: list[Record513]) -> dict[str, int]:
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

def route_513(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_513([payload])
    return summarize_513(records)

def helper_513_00(seed: int) -> int:
    acc = seed + 513 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_513_01(seed: int) -> int:
    acc = seed + 513 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_513_02(seed: int) -> int:
    acc = seed + 513 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_513_03(seed: int) -> int:
    acc = seed + 513 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_513_04(seed: int) -> int:
    acc = seed + 513 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_513_05(seed: int) -> int:
    acc = seed + 513 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_513_06(seed: int) -> int:
    acc = seed + 513 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

