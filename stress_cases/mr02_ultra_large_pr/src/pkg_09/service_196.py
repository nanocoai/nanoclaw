"""Generated service module 196 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-196"

@dataclass
class Record196:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_196(items: Iterable[Mapping[str, int]]) -> list[Record196]:
    output: list[Record196] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 196
        output.append(Record196(key=f"196-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_196(records: list[Record196]) -> dict[str, int]:
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

def route_196(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_196([payload])
    return summarize_196(records)

def helper_196_00(seed: int) -> int:
    acc = seed + 196 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_196_01(seed: int) -> int:
    acc = seed + 196 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_196_02(seed: int) -> int:
    acc = seed + 196 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_196_03(seed: int) -> int:
    acc = seed + 196 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_196_04(seed: int) -> int:
    acc = seed + 196 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_196_05(seed: int) -> int:
    acc = seed + 196 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_196_06(seed: int) -> int:
    acc = seed + 196 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

