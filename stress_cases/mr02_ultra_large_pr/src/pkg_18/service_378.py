"""Generated service module 378 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-378"

@dataclass
class Record378:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_378(items: Iterable[Mapping[str, int]]) -> list[Record378]:
    output: list[Record378] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 378
        output.append(Record378(key=f"378-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_378(records: list[Record378]) -> dict[str, int]:
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

def route_378(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_378([payload])
    return summarize_378(records)

def helper_378_00(seed: int) -> int:
    acc = seed + 378 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_378_01(seed: int) -> int:
    acc = seed + 378 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_378_02(seed: int) -> int:
    acc = seed + 378 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_378_03(seed: int) -> int:
    acc = seed + 378 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_378_04(seed: int) -> int:
    acc = seed + 378 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_378_05(seed: int) -> int:
    acc = seed + 378 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_378_06(seed: int) -> int:
    acc = seed + 378 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

