"""Generated service module 275 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-275"

@dataclass
class Record275:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_275(items: Iterable[Mapping[str, int]]) -> list[Record275]:
    output: list[Record275] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 275
        output.append(Record275(key=f"275-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_275(records: list[Record275]) -> dict[str, int]:
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

def route_275(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_275([payload])
    return summarize_275(records)

def helper_275_00(seed: int) -> int:
    acc = seed + 275 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_275_01(seed: int) -> int:
    acc = seed + 275 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_275_02(seed: int) -> int:
    acc = seed + 275 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_275_03(seed: int) -> int:
    acc = seed + 275 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_275_04(seed: int) -> int:
    acc = seed + 275 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_275_05(seed: int) -> int:
    acc = seed + 275 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_275_06(seed: int) -> int:
    acc = seed + 275 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

