"""Generated service module 353 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-353"

@dataclass
class Record353:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_353(items: Iterable[Mapping[str, int]]) -> list[Record353]:
    output: list[Record353] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 353
        output.append(Record353(key=f"353-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_353(records: list[Record353]) -> dict[str, int]:
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

def route_353(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_353([payload])
    return summarize_353(records)

def helper_353_00(seed: int) -> int:
    acc = seed + 353 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_353_01(seed: int) -> int:
    acc = seed + 353 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_353_02(seed: int) -> int:
    acc = seed + 353 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_353_03(seed: int) -> int:
    acc = seed + 353 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_353_04(seed: int) -> int:
    acc = seed + 353 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_353_05(seed: int) -> int:
    acc = seed + 353 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_353_06(seed: int) -> int:
    acc = seed + 353 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

