#!/usr/bin/env python3
"""
Render Leaflet HTML + KML from listings.jsonl (multi-source).

Usage:
    python3 render_map.py listings.jsonl out.html out.kml '2026-05-08T18:30:00+02:00'
"""
import html as htmllib
import json
import os
import sys
from collections import Counter

# Content de-dup fingerprint — same module the skill uses to skip repost
# alerts. Import from the skill dir (render_map runs from there in-container;
# add it to sys.path defensively for standalone runs).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from dedup import fingerprint_of
except ImportError:  # dedup.py absent (older deploy) → map keeps ID-only dedup
    fingerprint_of = None


SOURCE_LABEL = {
    "francezone-bbs2": "💬 bbs2",
    "francezone-bbs3": "💬 bbs3",
    "pap": "🇫🇷 pap",
}
SOURCE_FRIENDLY = {
    "francezone-bbs2": "francezone bbs2",
    "francezone-bbs3": "francezone bbs3",
    "pap": "pap.fr",
}


LEAFLET_TEMPLATE = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>__TITLE__</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css">
<link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css">
<style>
  html,body,#map{height:100%;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
  /* Map fills the entire viewport. The sidebar is an OVERLAY (position:fixed)
     so the map's pixel area is never resized when the sidebar toggles. */
  #map{position:absolute;inset:0;width:100%;height:100%}
  .popup{font-size:13px;line-height:1.45;max-width:280px}
  .popup h3{margin:0 0 6px;font-size:14px}
  .popup .src{display:inline-block;font-size:11px;background:#eef;color:#225;padding:1px 6px;border-radius:10px;margin-bottom:4px}
  .popup img{max-width:260px;border-radius:6px;margin:4px 0}
  .popup .meta{color:#555;margin-bottom:6px}
  .popup .body{color:#333;font-size:12px;max-height:120px;overflow:auto;border-top:1px solid #eee;padding-top:6px;margin-top:6px}
  .popup .btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .popup .btns a{display:inline-block;padding:5px 9px;border-radius:4px;text-decoration:none;font-size:12px;background:#1a73e8;color:#fff}
  .popup .btns a.alt{background:#34a853}
  .popup .btns a.alt2{background:#fbbc04;color:#222}
  .popup .ambig{color:#b06000;font-size:11px;margin-top:4px}
  .footer{position:fixed;bottom:6px;left:50%;transform:translateX(-50%);background:rgba(255,255,255,0.94);padding:6px 14px;border-radius:18px;box-shadow:0 1px 4px rgba(0,0,0,0.2);font-size:12px;z-index:1000}
  .footer a{color:#1a73e8}
  /* === Sidebar (overlay; preserves map area) === */
  #sidebar{
    position:fixed;top:0;left:0;height:100%;width:300px;max-width:85vw;
    background:rgba(255,255,255,0.97);box-shadow:2px 0 8px rgba(0,0,0,0.15);
    z-index:1100;overflow-y:auto;
    transition:transform .25s ease;transform:translateX(0);
    -webkit-backdrop-filter:saturate(180%) blur(4px);backdrop-filter:saturate(180%) blur(4px);
    font-size:13px;line-height:1.4
  }
  body.sidebar-side-right #sidebar{left:auto;right:0;box-shadow:-2px 0 8px rgba(0,0,0,0.15)}
  body.sidebar-closed #sidebar{transform:translateX(-100%)}
  body.sidebar-closed.sidebar-side-right #sidebar{transform:translateX(100%)}
  #sidebar-header{display:flex;align-items:center;justify-content:space-between;
    padding:10px 12px;border-bottom:1px solid #eee;background:#fafafa;
    position:sticky;top:0;z-index:2}
  #sidebar-header h2{margin:0;font-size:14px;font-weight:600;color:#222}
  #sidebar-side-btn{background:none;border:1px solid #ccc;border-radius:4px;
    padding:2px 6px;font-size:11px;cursor:pointer;color:#555}
  #sidebar-side-btn:hover{background:#f0f0f0}
  #sidebar-content{padding:12px}
  /* Toggle button — always visible. Sits OVER the map, never resizes the map. */
  #sidebar-toggle{
    position:fixed;top:10px;left:310px;z-index:1200;
    width:36px;height:36px;border-radius:6px;border:none;
    background:rgba(255,255,255,0.97);box-shadow:0 1px 4px rgba(0,0,0,0.25);
    font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;
    transition:left .25s ease,right .25s ease;color:#222
  }
  body.sidebar-closed #sidebar-toggle{left:10px}
  body.sidebar-side-right #sidebar-toggle{left:auto;right:310px}
  body.sidebar-closed.sidebar-side-right #sidebar-toggle{left:auto;right:10px}
  #sidebar-toggle:hover{background:#fff}
  /* Mobile: sidebar can be wider but still overlay */
  @media (max-width: 540px){
    #sidebar{width:280px}
    #sidebar-toggle{left:290px}
    body.sidebar-side-right #sidebar-toggle{right:290px;left:auto}
  }
  /* === Filter widgets === */
  .filter-group{margin:0 0 14px}
  .filter-group .label{display:block;font-weight:600;color:#222;margin:0 0 6px;font-size:12px;letter-spacing:.02em;text-transform:uppercase}
  .range-inputs{display:flex;align-items:center;gap:6px}
  .range-inputs input[type="number"]{
    flex:1;min-width:0;width:100%;
    padding:6px 8px;border:1px solid #ccc;border-radius:4px;
    font-size:13px;font-family:inherit;
    -moz-appearance:textfield;
  }
  .range-inputs input[type="number"]::-webkit-outer-spin-button,
  .range-inputs input[type="number"]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
  .range-inputs input[type="number"]:focus{outline:none;border-color:#1a73e8;box-shadow:0 0 0 2px rgba(26,115,232,0.15)}
  .range-inputs .sep{color:#888;font-size:13px;flex:0 0 auto}
  .range-inputs .unit{color:#666;font-size:11px;margin-left:4px;flex:0 0 auto}
  .filter-hint{color:#888;font-size:11px;margin:4px 0 0}
  .filter-actions{display:flex;justify-content:space-between;align-items:center;margin-top:6px;padding-top:10px;border-top:1px solid #eee}
  #filter-count{font-size:12px;color:#444}
  #filter-count strong{color:#1a73e8;font-weight:600}
  #filter-reset{
    background:none;border:1px solid #ccc;border-radius:4px;
    padding:4px 10px;font-size:12px;cursor:pointer;color:#444;font-family:inherit
  }
  #filter-reset:hover{background:#f0f0f0;border-color:#999}
  /* Categorical (multi-select) filters: chip-style checkboxes.
     Empty selection = no filter (matches "all 182 visible by default"). */
  .chip-group{display:flex;flex-wrap:wrap;gap:6px}
  .chip-group label{
    display:inline-flex;align-items:center;gap:4px;
    padding:4px 9px;border:1px solid #ccc;border-radius:14px;
    font-size:12px;color:#444;cursor:pointer;background:#fff;
    user-select:none;line-height:1.2;transition:background .12s,border-color .12s,color .12s
  }
  .chip-group label:hover{border-color:#1a73e8;color:#1a73e8}
  .chip-group input[type="checkbox"]{
    /* Hide native checkbox; the label IS the chip. */
    position:absolute;opacity:0;pointer-events:none;width:0;height:0;margin:0
  }
  .chip-group label:has(input:checked){
    background:#1a73e8;border-color:#1a73e8;color:#fff
  }
  /* Fallback for browsers without :has() — keyboard focus visibility. */
  .chip-group input[type="checkbox"]:focus-visible + span{outline:2px solid #1a73e8;outline-offset:2px;border-radius:2px}
  /* move-in single-toggle: a native checkbox + caption row.
     We keep the native control visible (unlike chip-group) because the
     single boolean is clearer as a checkbox than as a chip. */
  .movein-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;color:#222;font-size:13px;line-height:1.3}
  .movein-toggle input[type="checkbox"]{
    width:16px;height:16px;margin:0;accent-color:#1a73e8;cursor:pointer;flex:0 0 auto
  }
  .movein-toggle:hover span{color:#1a73e8}
  /* Metro-line filter: three sub-categories (Métro / RER / Tram) inside one
     filter-group, each rendered as its own chip-group with a small caption.
     Visually grouped so users can scan ~35 lines without losing the axis. */
  .chip-subgroup{margin-top:6px}
  .chip-subgroup:first-child{margin-top:0}
  .chip-subgroup .sublabel{
    display:block;font-size:10.5px;color:#888;font-weight:500;
    letter-spacing:.04em;text-transform:uppercase;margin:0 0 4px
  }
</style>
</head>
<body>
<div id="map"></div>
<aside id="sidebar" aria-label="필터" aria-hidden="false">
  <div id="sidebar-header">
    <h2>🔍 필터</h2>
    <button id="sidebar-side-btn" type="button" title="좌/우 위치 전환">⇄ 위치</button>
  </div>
  <div id="sidebar-content">
    <div class="filter-group" data-filter="price">
      <label class="label" for="filter-price-min">가격 (€/월)</label>
      <div class="range-inputs">
        <input type="number" id="filter-price-min" inputmode="numeric" placeholder="최소" min="0" step="50" aria-label="최소 가격">
        <span class="sep">–</span>
        <input type="number" id="filter-price-max" inputmode="numeric" placeholder="최대" min="0" step="50" aria-label="최대 가격">
      </div>
      <p class="filter-hint">비워두면 제한 없음 · 가격 미기재 매물 포함</p>
    </div>
    <div class="filter-group" data-filter="area">
      <label class="label" for="filter-area-min">면적 (m²)</label>
      <div class="range-inputs">
        <input type="number" id="filter-area-min" inputmode="numeric" placeholder="최소" min="0" step="5" aria-label="최소 면적">
        <span class="sep">–</span>
        <input type="number" id="filter-area-max" inputmode="numeric" placeholder="최대" min="0" step="5" aria-label="최대 면적">
      </div>
      <p class="filter-hint">비워두면 제한 없음 · 면적 미기재 매물 포함</p>
    </div>
    <div class="filter-group" data-filter="rooms">
      <span class="label">방 수</span>
      <div class="chip-group" id="filter-rooms" role="group" aria-label="방 수 필터">
        <label><input type="checkbox" class="filter-rooms" value="T1"><span>T1</span></label>
        <label><input type="checkbox" class="filter-rooms" value="T2"><span>T2</span></label>
        <label><input type="checkbox" class="filter-rooms" value="T3"><span>T3</span></label>
        <label><input type="checkbox" class="filter-rooms" value="T4+"><span>T4+</span></label>
        <label><input type="checkbox" class="filter-rooms" value="unknown"><span>미기재</span></label>
      </div>
      <p class="filter-hint">선택 안 함 = 전체</p>
    </div>
    <div class="filter-group" data-filter="meuble">
      <span class="label">가구</span>
      <div class="chip-group" id="filter-meuble" role="group" aria-label="가구 유무 필터">
        <label><input type="checkbox" class="filter-meuble" value="meuble"><span>가구 포함</span></label>
        <label><input type="checkbox" class="filter-meuble" value="non"><span>빈집</span></label>
        <label><input type="checkbox" class="filter-meuble" value="unknown"><span>미기재</span></label>
      </div>
      <p class="filter-hint">선택 안 함 = 전체</p>
    </div>
    <div class="filter-group" data-filter="move-in">
      <span class="label">입주일</span>
      <label class="movein-toggle">
        <input type="checkbox" id="filter-movein" class="filter-movein">
        <span>2026-06 이후 또는 미기재만</span>
      </label>
      <p class="filter-hint">체크 해제 = 전체 · 입주일 미기재/협의 매물도 통과</p>
    </div>
    <div class="filter-group" data-filter="term">
      <span class="label">기간 유형</span>
      <div class="chip-group" id="filter-term" role="group" aria-label="장기/단기 필터">
        <label><input type="checkbox" class="filter-term" value="long"><span>🏠 장기</span></label>
        <label><input type="checkbox" class="filter-term" value="short"><span>⛱️ 단기</span></label>
        <label><input type="checkbox" class="filter-term" value="flex"><span>🔁 유연</span></label>
        <label><input type="checkbox" class="filter-term" value="unknown"><span>미기재</span></label>
      </div>
      <p class="filter-hint">선택 안 함 = 전체 (장기+단기 여름)</p>
    </div>
    <div class="filter-group" data-filter="sources">
      <span class="label">출처</span>
      <div class="chip-group" id="filter-sources" role="group" aria-label="매물 출처 필터">
        <label><input type="checkbox" class="filter-sources" value="francezone-bbs2"><span>💬 bbs2</span></label>
        <label><input type="checkbox" class="filter-sources" value="francezone-bbs3"><span>💬 bbs3</span></label>
        <label><input type="checkbox" class="filter-sources" value="pap"><span>🇫🇷 pap</span></label>
      </div>
      <p class="filter-hint">선택 안 함 = 전체</p>
    </div>
    <div class="filter-group" data-filter="arr">
      <span class="label">구 / 지역</span>
      <div class="chip-group" id="filter-arr" role="group" aria-label="구 또는 우편번호 필터">
        <label><input type="checkbox" class="filter-arr" value="1"><span>1구</span></label>
        <label><input type="checkbox" class="filter-arr" value="2"><span>2구</span></label>
        <label><input type="checkbox" class="filter-arr" value="3"><span>3구</span></label>
        <label><input type="checkbox" class="filter-arr" value="4"><span>4구</span></label>
        <label><input type="checkbox" class="filter-arr" value="5"><span>5구</span></label>
        <label><input type="checkbox" class="filter-arr" value="6"><span>6구</span></label>
        <label><input type="checkbox" class="filter-arr" value="7"><span>7구</span></label>
        <label><input type="checkbox" class="filter-arr" value="8"><span>8구</span></label>
        <label><input type="checkbox" class="filter-arr" value="9"><span>9구</span></label>
        <label><input type="checkbox" class="filter-arr" value="10"><span>10구</span></label>
        <label><input type="checkbox" class="filter-arr" value="11"><span>11구</span></label>
        <label><input type="checkbox" class="filter-arr" value="12"><span>12구</span></label>
        <label><input type="checkbox" class="filter-arr" value="13"><span>13구</span></label>
        <label><input type="checkbox" class="filter-arr" value="14"><span>14구</span></label>
        <label><input type="checkbox" class="filter-arr" value="15"><span>15구</span></label>
        <label><input type="checkbox" class="filter-arr" value="16"><span>16구</span></label>
        <label><input type="checkbox" class="filter-arr" value="17"><span>17구</span></label>
        <label><input type="checkbox" class="filter-arr" value="18"><span>18구</span></label>
        <label><input type="checkbox" class="filter-arr" value="19"><span>19구</span></label>
        <label><input type="checkbox" class="filter-arr" value="20"><span>20구</span></label>
        <label><input type="checkbox" class="filter-arr" value="92"><span>92 (Hauts-de-Seine)</span></label>
        <label><input type="checkbox" class="filter-arr" value="93"><span>93 (Seine-St-Denis)</span></label>
        <label><input type="checkbox" class="filter-arr" value="94"><span>94 (Val-de-Marne)</span></label>
        <label><input type="checkbox" class="filter-arr" value="unknown"><span>미기재</span></label>
      </div>
      <p class="filter-hint">선택 안 함 = 전체 · 75001–75020 = 1–20구, 92/93/94 = 우편번호 앞 두 자리</p>
    </div>
    <div class="filter-group" data-filter="line">
      <span class="label">메트로 / RER / 트램</span>
      <div class="chip-subgroup">
        <span class="sublabel">Métro</span>
        <div class="chip-group" id="filter-line-metro" role="group" aria-label="메트로 라인 필터">
          <label><input type="checkbox" class="filter-line" value="M1"><span>M1</span></label>
          <label><input type="checkbox" class="filter-line" value="M2"><span>M2</span></label>
          <label><input type="checkbox" class="filter-line" value="M3"><span>M3</span></label>
          <label><input type="checkbox" class="filter-line" value="M3bis"><span>M3bis</span></label>
          <label><input type="checkbox" class="filter-line" value="M4"><span>M4</span></label>
          <label><input type="checkbox" class="filter-line" value="M5"><span>M5</span></label>
          <label><input type="checkbox" class="filter-line" value="M6"><span>M6</span></label>
          <label><input type="checkbox" class="filter-line" value="M7"><span>M7</span></label>
          <label><input type="checkbox" class="filter-line" value="M7bis"><span>M7bis</span></label>
          <label><input type="checkbox" class="filter-line" value="M8"><span>M8</span></label>
          <label><input type="checkbox" class="filter-line" value="M9"><span>M9</span></label>
          <label><input type="checkbox" class="filter-line" value="M10"><span>M10</span></label>
          <label><input type="checkbox" class="filter-line" value="M11"><span>M11</span></label>
          <label><input type="checkbox" class="filter-line" value="M12"><span>M12</span></label>
          <label><input type="checkbox" class="filter-line" value="M13"><span>M13</span></label>
          <label><input type="checkbox" class="filter-line" value="M14"><span>M14</span></label>
        </div>
      </div>
      <div class="chip-subgroup">
        <span class="sublabel">RER</span>
        <div class="chip-group" id="filter-line-rer" role="group" aria-label="RER 라인 필터">
          <label><input type="checkbox" class="filter-line" value="RER-A"><span>RER A</span></label>
          <label><input type="checkbox" class="filter-line" value="RER-B"><span>RER B</span></label>
          <label><input type="checkbox" class="filter-line" value="RER-C"><span>RER C</span></label>
          <label><input type="checkbox" class="filter-line" value="RER-D"><span>RER D</span></label>
          <label><input type="checkbox" class="filter-line" value="RER-E"><span>RER E</span></label>
        </div>
      </div>
      <div class="chip-subgroup">
        <span class="sublabel">Tram</span>
        <div class="chip-group" id="filter-line-tram" role="group" aria-label="트램 라인 필터">
          <label><input type="checkbox" class="filter-line" value="T1"><span>T1</span></label>
          <label><input type="checkbox" class="filter-line" value="T2"><span>T2</span></label>
          <label><input type="checkbox" class="filter-line" value="T3a"><span>T3a</span></label>
          <label><input type="checkbox" class="filter-line" value="T3b"><span>T3b</span></label>
          <label><input type="checkbox" class="filter-line" value="T4"><span>T4</span></label>
          <label><input type="checkbox" class="filter-line" value="T5"><span>T5</span></label>
          <label><input type="checkbox" class="filter-line" value="T6"><span>T6</span></label>
          <label><input type="checkbox" class="filter-line" value="T7"><span>T7</span></label>
          <label><input type="checkbox" class="filter-line" value="T8"><span>T8</span></label>
          <label><input type="checkbox" class="filter-line" value="T9"><span>T9</span></label>
          <label><input type="checkbox" class="filter-line" value="T10"><span>T10</span></label>
          <label><input type="checkbox" class="filter-line" value="T11"><span>T11</span></label>
          <label><input type="checkbox" class="filter-line" value="T12"><span>T12</span></label>
          <label><input type="checkbox" class="filter-line" value="T13"><span>T13</span></label>
        </div>
      </div>
      <p class="filter-hint">선택 안 함 = 전체 · 구 필터와는 <strong>OR</strong> 결합 (15구 OR M14 = 15구이거나 M14 직통)</p>
    </div>
    <div class="filter-actions">
      <span id="filter-count" aria-live="polite"><strong>__</strong> / __ 건</span>
      <button type="button" id="filter-reset" title="모든 필터 초기화">초기화</button>
    </div>
  </div>
</aside>
<button id="sidebar-toggle" type="button" aria-label="사이드바 토글" aria-controls="sidebar" aria-expanded="true" title="사이드바 토글">≡</button>
<div class="footer">__FOOTER__ · <a href="paris-realestate.kml" download>KML 다운로드</a></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script>
const LISTINGS = __LISTINGS_JSON__;
const SOURCE_LABEL = __SOURCE_LABEL_JSON__;
const map = L.map('map').setView([48.8566, 2.3522], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap', maxZoom: 19
}).addTo(map);

const cluster = L.markerClusterGroup({spiderfyOnMaxZoom:true,showCoverageOnHover:false,maxClusterRadius:35});
const idToMarker = {};

// Verdict: color (green=pass, yellow=ambig). Source: shape (circle/diamond/star).
function pinIcon(verdict, source){
  const color = verdict === 'pass' ? '#34a853' : '#fbbc04';
  let shape;
  if (source === 'francezone-bbs3') {
    // Diamond
    shape = '<polygon points="12,1 23,12 12,31 1,12" fill="'+color+'" stroke="#222" stroke-width="1"/>';
  } else if (source === 'pap') {
    // Star
    shape = '<polygon points="12,2 14.5,9.2 22,9.5 16,14 18,22 12,17.5 6,22 8,14 2,9.5 9.5,9.2" fill="'+color+'" stroke="#222" stroke-width="1"/>';
  } else {
    // Circle (default — francezone-bbs2 or unknown)
    shape = '<path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12z" fill="'+color+'" stroke="#222" stroke-width="1"/><circle cx="12" cy="12" r="4.5" fill="#fff"/>';
  }
  return L.divIcon({
    className:'',
    iconSize:[24,32],
    iconAnchor:[12,30],
    popupAnchor:[0,-26],
    html:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32">'+shape+'</svg>'
  });
}

function escapeHtml(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);}
function escapeAttr(s){return escapeHtml(s).replace(/'/g,'&#39;');}

function popupHtml(d){
  const photo = d.photo_url ? '<img src="'+escapeAttr(d.photo_url)+'" loading="lazy">' : '';
  const ambig = (d.ambiguous_axes && d.ambiguous_axes.length)
    ? '<div class="ambig">⚠️ 모호: '+escapeHtml(d.ambiguous_axes.join(', '))+'</div>' : '';
  const moveIn = d.move_in || '미기재';
  const area = d.area_m2 != null ? d.area_m2+'m²' : '면적 미기재';
  // Short-term prices are stored as a monthly-equivalent (weekly×4.345 etc.),
  // so flag them as approximate with the original unit for transparency.
  const isShortPrice = d.price_unit && d.price_unit !== 'monthly';
  const price = d.price_eur != null
    ? (isShortPrice ? '≈'+d.price_eur+'€/월(환산)' : d.price_eur+'€/월')
    : '가격 미기재';
  const TERM_LABEL = {long:'🏠 장기', short:'⛱️ 단기', flex:'🔁 유연'};
  const termLabel = TERM_LABEL[d.term] || '';
  const termBadge = termLabel ? '<span class="src">'+termLabel+'</span>' : '';
  const srcBadge = SOURCE_LABEL[d.source] ? '<span class="src">'+SOURCE_LABEL[d.source]+'</span>' : '';
  const gmaps = 'https://www.google.com/maps/search/?api=1&query='+d.lat+','+d.lng;
  const gdir  = 'https://www.google.com/maps/dir/?api=1&destination='+d.lat+','+d.lng;
  const gpano = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint='+d.lat+','+d.lng;
  return '<div class="popup">'
    + srcBadge + termBadge
    + '<h3>'+escapeHtml(d.title)+'</h3>'
    + '<div class="meta">📍 '+escapeHtml(d.location_text||'위치 미상')
    + ' · '+area+' · '+price
    + '<br>🗓️ 입주: '+escapeHtml(moveIn)+'</div>'
    + photo
    + ambig
    + '<div class="body">'+escapeHtml(d.raw_body_excerpt||'').replace(/\\n/g,'<br>')+'</div>'
    + '<div class="btns">'
    +   '<a href="'+escapeAttr(d.url)+'" target="_blank">🔗 원글</a>'
    +   '<a class="alt" href="'+gmaps+'" target="_blank">🌍 Google Maps</a>'
    +   '<a class="alt" href="'+gdir+'" target="_blank">🚶 길찾기</a>'
    +   '<a class="alt2" href="'+gpano+'" target="_blank">👁️ 스트리트뷰</a>'
    + '</div>'
    + '</div>';
}

// Keep marker objects paired with their listing so filters can re-populate
// the cluster without re-creating markers / popups / icons.
const allEntries = []; // [{listing, marker}, ...]
LISTINGS.forEach(d => {
  const m = L.marker([d.lat, d.lng], {icon: pinIcon(d.verdict, d.source)});
  m.bindPopup(popupHtml(d), {maxWidth: 320});
  allEntries.push({listing: d, marker: m});
  // Index by both bare post_id and namespaced_id for hash deep links
  if (d.namespaced_id) idToMarker[d.namespaced_id] = m;
  if (d.post_id) idToMarker[d.post_id] = m;
});
map.addLayer(cluster);
// Initial population — no filters active yet.
cluster.addLayers(allEntries.map(e => e.marker));

if (LISTINGS.length > 0) {
  const bounds = L.latLngBounds(LISTINGS.map(d => [d.lat, d.lng]));
  map.fitBounds(bounds.pad(0.2));
}

function openHash(){
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id) return;
  const m = idToMarker[id];
  if (m) {
    map.setView(m.getLatLng(), 15);
    cluster.zoomToShowLayer(m, () => m.openPopup());
  }
}
window.addEventListener('hashchange', openHash);
openHash();

/* === Sidebar toggle (overlay; map area is preserved) ===
   The sidebar is position:fixed and overlays the map. The Leaflet map
   container is never resized when toggling — it stays at 100% of the
   viewport so pan/zoom state and tile cache are preserved. We still call
   map.invalidateSize() defensively in case CSS transitions or browser
   layout do shift anything (e.g. scrollbars on tiny viewports). */
(function initSidebar(){
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const sideBtn = document.getElementById('sidebar-side-btn');
  if (!sidebar || !toggleBtn) return;
  const LS_OPEN = 'paris-sidebar-open';
  const LS_SIDE = 'paris-sidebar-side'; // 'left' | 'right'

  function applyOpen(open){
    document.body.classList.toggle('sidebar-closed', !open);
    toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
    try { localStorage.setItem(LS_OPEN, open ? '1' : '0'); } catch (e) {}
    // Defensive redraw — map size shouldn't change (overlay), but call
    // invalidateSize after the CSS transition just in case the browser
    // adjusted scrollbars or zoom.
    setTimeout(() => { try { map.invalidateSize({pan:false}); } catch(e){} }, 280);
  }
  function applySide(side){
    const right = side === 'right';
    document.body.classList.toggle('sidebar-side-right', right);
    try { localStorage.setItem(LS_SIDE, right ? 'right' : 'left'); } catch (e) {}
    setTimeout(() => { try { map.invalidateSize({pan:false}); } catch(e){} }, 280);
  }

  toggleBtn.addEventListener('click', () => {
    const isClosed = document.body.classList.contains('sidebar-closed');
    applyOpen(isClosed); // toggle
  });
  if (sideBtn){
    sideBtn.addEventListener('click', () => {
      const right = !document.body.classList.contains('sidebar-side-right');
      applySide(right ? 'right' : 'left');
    });
  }

  // Restore prior state. Default: open on desktop, closed on narrow screens.
  let storedOpen = null, storedSide = null;
  try { storedOpen = localStorage.getItem(LS_OPEN); storedSide = localStorage.getItem(LS_SIDE); } catch(e) {}
  const defaultOpen = window.innerWidth >= 600;
  applySide(storedSide === 'right' ? 'right' : 'left');
  applyOpen(storedOpen === null ? defaultOpen : storedOpen === '1');

  // Keep map sized correctly on viewport changes.
  window.addEventListener('resize', () => {
    try { map.invalidateSize({pan:false}); } catch(e){}
  });
})();

/* === Central filter state manager (Sub-AC 1.5.1) ===
   FilterState is the SINGLE SOURCE OF TRUTH for every filter dimension and
   exposes a tiny pub/sub API — get / set / replace / reset / subscribe — so
   the marker re-renderer, count display, and (in later sub-ACs) the URL-hash
   serializer, hash→state restore handler, and metro-line UI all hook in via
   subscribe() and react to a single notification per state change. set() is
   a no-op when the patch produces no semantic change, so redundant DOM
   events (e.g. typing the same digit) don't thrash cluster.clearLayers.

   Held dimensions (7 logical axes; arr+metro share the "location" axis and
   are OR-combined inside passesFilter):
     1. price   priceMin / priceMax — null = unbounded on that side
     2. area    areaMin  / areaMax  — null = unbounded
     3. rooms   roomsSelected   ⊂ ['T1','T2','T3','T4+','unknown']; [] = no filter
     4. meuble  meubleSelected  ⊂ ['meuble','non','unknown'];        [] = no filter
     5. move-in moveInAfter202606 — boolean; false = no filter
     6. term    termSelected    ⊂ ['long','short','flex','unknown']; [] = no filter
     7. sources sourcesSelected ⊂ ['francezone-bbs2','francezone-bbs3','pap']; [] = no filter
     8. location:
          - arrSelected         ⊂ ['1'..'20','92','93','94','unknown']; [] = no filter
          - metroLinesSelected  ⊂ metro/RER/tram line ids; [] = no filter
        (held here; OR-combined and gated through passesFilter — see the
        location-axis wiring sub-AC.)

   Conventions:
   - Range null on a bound = no bound there. Listing values that are null on
     the underlying field PASS (don't punish missing data — surface them and
     mark "미기재" in the popup).
   - Categorical [] = no filter on that axis → everything passes. A listing
     with a missing field is bucketed as 'unknown' so users can opt in/out
     via the "미기재" chip.
   - moveInAfter202606=true: listing passes iff a parseable move_in is
     >= 2026-06, OR the field is missing / 'flexible' / unparseable. */
const FilterState = (function(){
  function defaults(){
    return {
      priceMin: null, priceMax: null,
      areaMin:  null, areaMax:  null,
      roomsSelected:      [],
      meubleSelected:     [],
      moveInAfter202606:  false,
      termSelected:       [],
      sourcesSelected:    [],
      arrSelected:        [],
      metroLinesSelected: [],
    };
  }
  const KEYS = Object.keys(defaults());
  let state = defaults();
  const subs = [];

  function arrayEqual(a, b){
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function snapshot(){
    // Frozen, one-level-copied snapshot — subscribers can't mutate the
    // internal arrays through the snapshot they receive.
    return Object.freeze({
      priceMin: state.priceMin,
      priceMax: state.priceMax,
      areaMin:  state.areaMin,
      areaMax:  state.areaMax,
      roomsSelected:      state.roomsSelected.slice(),
      meubleSelected:     state.meubleSelected.slice(),
      moveInAfter202606:  state.moveInAfter202606,
      termSelected:       state.termSelected.slice(),
      sourcesSelected:    state.sourcesSelected.slice(),
      arrSelected:        state.arrSelected.slice(),
      metroLinesSelected: state.metroLinesSelected.slice(),
    });
  }
  function applyPatch(target, patch){
    // Copy only known keys; coerce defensively. Returns whether anything
    // changed (used by set() to skip redundant notifications).
    let changed = false;
    const def = defaults();
    for (let i = 0; i < KEYS.length; i++){
      const k = KEYS[i];
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      const v = patch[k];
      if (Array.isArray(def[k])){
        const next = Array.isArray(v) ? v.slice() : [];
        if (!arrayEqual(target[k], next)){ target[k] = next; changed = true; }
      } else if (typeof def[k] === 'boolean'){
        const next = !!v;
        if (target[k] !== next){ target[k] = next; changed = true; }
      } else {
        // Range bound: collapse undefined/empty-string to null.
        const next = (v == null || v === '') ? null : v;
        if (target[k] !== next){ target[k] = next; changed = true; }
      }
    }
    return changed;
  }
  function notify(){
    const snap = snapshot();
    // Iterate a copy so subscribers can unsubscribe during notify().
    const list = subs.slice();
    for (let i = 0; i < list.length; i++){
      try { list[i](snap); } catch(e){ /* swallow per-subscriber errors */ }
    }
  }
  return {
    get: snapshot,
    set: function(patch){
      if (!patch || typeof patch !== 'object') return false;
      const changed = applyPatch(state, patch);
      if (changed) notify();
      return changed;
    },
    replace: function(next){
      // For URL-hash restore (a later sub-AC): replace the WHOLE state in
      // one notification. Always notifies even if value-equal so callers can
      // force a re-sync of DOM and markers.
      const fresh = defaults();
      if (next && typeof next === 'object') applyPatch(fresh, next);
      state = fresh;
      notify();
    },
    reset: function(){
      state = defaults();
      notify();
    },
    subscribe: function(fn){
      if (typeof fn !== 'function') return function(){};
      subs.push(fn);
      return function unsubscribe(){
        const i = subs.indexOf(fn);
        if (i !== -1) subs.splice(i, 1);
      };
    },
    // Ordered list of dimension keys — useful for hash serializers and tests
    // (non-enumerable callers shouldn't have to hard-code this list).
    DIMENSIONS: KEYS.slice(),
  };
})();

/* arrBucket: derive the chip value used by the arrondissement filter from
   a listing's zip_or_arr field.
     - Paris postcodes 75001..75020 → '1'..'20' (last two digits, leading
       zero stripped — chips are labeled "1구"..."20구")
     - Inner-suburb postcodes starting with 92/93/94 → the two-digit
       department prefix ('92', '93', '94')
     - Anything else (missing, malformed, or another department) → 'unknown'
   This mapping is intentionally one-to-one with the chip values defined in
   the sidebar HTML above so inSet() in passesFilter() can compare directly. */
function arrBucket(zip){
  if (zip == null) return 'unknown';
  const s = String(zip).trim();
  if (s === '') return 'unknown';
  const m75 = /^75(\d{3})$/.exec(s);
  if (m75){
    const n = parseInt(m75[1], 10);
    if (n >= 1 && n <= 20) return String(n);
    return 'unknown';
  }
  if (/^9[234]\d{3}$/.test(s)) return s.slice(0, 2);
  return 'unknown';
}

function inRange(v, min, max){
  // null/undefined value → treat as "unknown, do not filter out"
  if (v == null) return true;
  if (min != null && v < min) return false;
  if (max != null && v > max) return false;
  return true;
}

function inSet(v, selected){
  // Empty selection = no filter applied → everything passes.
  if (!selected || selected.length === 0) return true;
  // Treat missing/null/empty-string as the literal bucket 'unknown'.
  const bucket = (v == null || v === '') ? 'unknown' : v;
  return selected.indexOf(bucket) !== -1;
}

/* === Location axis helpers (arr ∪ metro-line OR-combination) ===
   Chip values for metro-line filters use the URL-friendly grammar from the
   Seed (#line=M14,RER-A,T3a). The underlying listing data — populated by
   geocode.py via idf_stations.json (AC 9) — uses the OSM-canonical line ids
   ("M14", "RER A", "T3a"). chipLineToListingLine() bridges the two so the
   only place hyphen-vs-space normalization happens is at the comparison
   boundary; chip values, hash tokens, and DOM `value` attributes all stay
   in lockstep.

   Why a one-way map (chip→listing) and not the reverse: listings can have
   multiple lines per pin (a station served by M1+M4+RER A), and we only ever
   ask "is any selected chip's underlying line in this listing's line list?".
   So we translate the small selected-chip set once and check membership. */
function chipLineToListingLine(chip){
  if (typeof chip !== 'string' || chip === '') return chip;
  // 'RER-A' → 'RER A'. Métro and Tram chip values are identity (M14, T3a).
  if (chip.indexOf('RER-') === 0) return 'RER ' + chip.slice(4);
  return chip;
}

function listingLinesMatch(listingLines, selectedChips){
  // True iff any selected chip resolves to a line listed on this pin.
  // Listings without a metro_lines field (e.g. geocoded via Nominatim or
  // arrondissement centroid) implicitly fail this dimension — they may still
  // pass the location axis through arrSelected (the other half of the OR).
  if (!Array.isArray(listingLines) || listingLines.length === 0) return false;
  for (let i = 0; i < selectedChips.length; i++){
    const target = chipLineToListingLine(selectedChips[i]);
    if (listingLines.indexOf(target) !== -1) return true;
  }
  return false;
}

function passesLocation(d, s){
  // Location axis = (arrSelected) ∪ (metroLinesSelected). Per the Seed:
  //   "위치 필터는 구 번호 multi-select 와 메트로 라인 multi-select 의 OR 결합"
  // Semantics:
  //   • Both empty           → no location filter, everything passes.
  //   • Only arr selected    → existing AND-style arr filter (legacy parity).
  //   • Only line selected   → listing.metro_lines must intersect the chips.
  //   • Both selected        → listing passes if EITHER side matches (OR),
  //                            so "15구 OR M14 직통" returns the union.
  const arrEmpty  = !s.arrSelected         || s.arrSelected.length === 0;
  const lineEmpty = !s.metroLinesSelected  || s.metroLinesSelected.length === 0;
  if (arrEmpty && lineEmpty) return true;

  const arrMatch  = !arrEmpty  && inSet(arrBucket(d.zip_or_arr), s.arrSelected);
  const lineMatch = !lineEmpty && listingLinesMatch(d.metro_lines, s.metroLinesSelected);

  if (arrEmpty)  return lineMatch;     // line-only filter
  if (lineEmpty) return arrMatch;      // arr-only filter (existing behavior)
  return arrMatch || lineMatch;        // BOTH active → OR
}

// move_in axis: returns true if listing passes the "≥2026-06 or missing" gate.
// When the toggle is OFF, callers don't invoke this — they short-circuit pass.
// Accepted move_in formats per classify_rules.md: "YYYY-MM-DD", "flexible",
// or null/empty. We treat any non-parseable string the same as missing
// (don't punish ambiguous data).
function moveInOk(m){
  if (m == null) return true;
  const s = String(m).trim();
  if (s === '' || s.toLowerCase() === 'flexible') return true;
  // Only reject if we can definitively parse a YYYY-MM date BEFORE 2026-06.
  const match = /^(\d{4})-(\d{1,2})/.exec(s);
  if (!match) return true; // unparseable → treat as missing
  const y = parseInt(match[1], 10);
  const mm = parseInt(match[2], 10);
  if (!Number.isFinite(y) || !Number.isFinite(mm)) return true;
  if (y > 2026) return true;
  if (y === 2026 && mm >= 6) return true;
  return false;
}

function passesFilter(d, s){
  // s is a frozen FilterState snapshot. Pass it explicitly (rather than
  // closing over a global) so this function is pure-ish and easy to test.
  if (!inRange(d.price_eur, s.priceMin, s.priceMax)) return false;
  if (!inRange(d.area_m2,   s.areaMin,  s.areaMax))  return false;
  if (!inSet(d.rooms,  s.roomsSelected))  return false;
  if (!inSet(d.meuble, s.meubleSelected)) return false;
  if (s.moveInAfter202606 && !moveInOk(d.move_in)) return false;
  if (!inSet(d.term,   s.termSelected))   return false;
  if (!inSet(d.source, s.sourcesSelected)) return false;
  // Location axis: arr ∪ metro-line. Both halves combined inside
  // passesLocation() so the OR-semantics live in one auditable place.
  if (!passesLocation(d, s)) return false;
  return true;
}

function applyFilters(s){
  // Subscriber callback: receives a frozen FilterState snapshot. When called
  // directly (initial paint or programmatic refresh), fall back to the
  // current snapshot.
  s = s || FilterState.get();
  const visible = [];
  for (const e of allEntries){
    if (passesFilter(e.listing, s)) visible.push(e.marker);
  }
  cluster.clearLayers();
  cluster.addLayers(visible);
  const countEl = document.getElementById('filter-count');
  if (countEl){
    countEl.innerHTML = '<strong>'+visible.length+'</strong> / '+allEntries.length+' 건';
  }
}
// Re-render markers + count whenever any filter dimension changes. Other
// subscribers (URL-hash writer, DOM-syncer for hash restore) attach later.
FilterState.subscribe(applyFilters);

/* === URL-hash serialization (Sub-AC 1.5.3) ===
   Two-way binding between FilterState and location.hash so filter combinations
   are shareable / bookmarkable / survive page reloads.

   Hash grammar (everything after the literal '#'):
     k=v(&k=v)* — only keys whose dimension is non-default appear, so an empty
     hash means "no filters" (matches the default state).

     price   = MIN-MAX        (either side empty → unbounded; e.g. "400-",  "-1500")
     area    = MIN-MAX        (same as price)
     rooms   = T1,T2,T3,T4+,unknown   (CSV; chip values; '+' percent-encoded
                                        as %2B by the writer; commas left literal)
     meuble  = meuble,non,unknown
     movein  = 1              (presence = true; absent = false)
     sources = francezone-bbs2,francezone-bbs3,pap
     arr     = 1,…,20,92,93,94,unknown
     line    = M1,…,M14,RER-A,…,RER-E,T1,…,T13   (metro-line UI ships in a later
                                                  sub-AC; the slot exists today)

   Coexistence with openHash() deep-link-by-id:
     The pre-existing openHash() handler interprets the entire hash as a
     listing id and centers the map on that marker. Filter hashes always
     contain '=' (they're query-string-like); deep-link hashes never do
     (post_id / namespaced_id are id-shaped). isFilterHash() short-circuits
     on that distinction so the two formats never clobber each other. */
const FilterHash = (function(){
  function parseRange(v){
    // Accepts "min-max", "min-", "-max", or "-" (the last two collapse to
    // null on the empty side). Returns [min,max] with nulls on degenerate
    // input — keeps the parser tolerant of hand-edited URLs.
    const m = /^(-?\d*\.?\d*)-(-?\d*\.?\d*)$/.exec(String(v));
    if (!m) return [null, null];
    const a = (m[1] === '' || m[1] === '-') ? null : parseFloat(m[1]);
    const b = (m[2] === '' || m[2] === '-') ? null : parseFloat(m[2]);
    return [Number.isFinite(a) ? a : null, Number.isFinite(b) ? b : null];
  }
  function buildRange(lo, hi){
    if (lo == null && hi == null) return null;
    return (lo == null ? '' : String(lo)) + '-' + (hi == null ? '' : String(hi));
  }
  function serialize(s){
    // Build hash body (no leading '#'). Skip every dimension at its default
    // value so the URL stays clean: "no filter" → empty body.
    const parts = [];
    function emit(k, raw){
      // Encode k/v separately so internal commas stay literal between CSV
      // elements (encodeURIComponent encodes ',' as %2C — we want literal
      // commas for human-readable hashes, matching the Seed example).
      const encV = encodeURIComponent(raw).replace(/%2C/g, ',');
      parts.push(encodeURIComponent(k) + '=' + encV);
    }
    function emitCsv(k, arr){
      if (!arr || arr.length === 0) return;
      emit(k, arr.join(','));
    }
    const price = buildRange(s.priceMin, s.priceMax); if (price) emit('price', price);
    const area  = buildRange(s.areaMin,  s.areaMax);  if (area)  emit('area',  area);
    emitCsv('rooms',   s.roomsSelected);
    emitCsv('meuble',  s.meubleSelected);
    if (s.moveInAfter202606) emit('movein', '1');
    emitCsv('term',    s.termSelected);
    emitCsv('sources', s.sourcesSelected);
    emitCsv('arr',     s.arrSelected);
    emitCsv('line',    s.metroLinesSelected);
    return parts.join('&');
  }
  function isFilterHash(hash){
    // A filter hash is a query-string-shaped body after '#'. The legacy
    // openHash() deep-link uses bare ids (no '='), so the two never collide.
    if (typeof hash !== 'string' || hash === '') return false;
    const h = hash.charAt(0) === '#' ? hash.slice(1) : hash;
    return h !== '' && h.indexOf('=') !== -1;
  }
  function parse(hash){
    // Returns a complete FilterState patch — every dimension key is present,
    // missing keys collapse to their defaults so a partial hash like
    // "rooms=T2" produces a state that is "T2 only, everything else default".
    const patch = {
      priceMin: null, priceMax: null,
      areaMin: null,  areaMax: null,
      roomsSelected: [], meubleSelected: [],
      moveInAfter202606: false,
      termSelected: [],
      sourcesSelected: [], arrSelected: [], metroLinesSelected: [],
    };
    if (typeof hash !== 'string') return patch;
    let h = hash.charAt(0) === '#' ? hash.slice(1) : hash;
    if (h === '') return patch;
    function dec(s){ try { return decodeURIComponent(s.replace(/\+/g, '%20')); } catch(e){ return s; } }
    function csv(s){
      // Splits on literal commas (post-decode). Empty/whitespace tokens are
      // dropped so "rooms=,T2," still parses cleanly to ['T2'].
      return dec(s).split(',').map(t => t.trim()).filter(function(t){ return t !== ''; });
    }
    const segs = h.split('&');
    for (let i = 0; i < segs.length; i++){
      const seg = segs[i];
      if (seg === '') continue;
      const eq = seg.indexOf('=');
      if (eq === -1) continue; // bare token without value — ignore
      const k = dec(seg.slice(0, eq));
      const v = seg.slice(eq + 1);
      if (k === 'price') {
        const r = parseRange(dec(v)); patch.priceMin = r[0]; patch.priceMax = r[1];
      } else if (k === 'area') {
        const r = parseRange(dec(v)); patch.areaMin = r[0]; patch.areaMax = r[1];
      } else if (k === 'rooms')   { patch.roomsSelected      = csv(v); }
      else if   (k === 'meuble')  { patch.meubleSelected     = csv(v); }
      else if   (k === 'movein')  { patch.moveInAfter202606  = dec(v) === '1'; }
      else if   (k === 'term')    { patch.termSelected       = csv(v); }
      else if   (k === 'sources') { patch.sourcesSelected    = csv(v); }
      else if   (k === 'arr')     { patch.arrSelected        = csv(v); }
      else if   (k === 'line')    { patch.metroLinesSelected = csv(v); }
      // Unknown keys are ignored — forward-compat for future axes.
    }
    return patch;
  }
  return { serialize: serialize, parse: parse, isFilterHash: isFilterHash };
})();

(function initHashBinding(){
  /* DOM ← state syncer. Called explicitly from restoreFromHash() after a
     FilterState.replace, NOT subscribed to FilterState. If it were a global
     subscriber it would write back to inputs the user is typing into,
     causing cursor jumps and disrupting in-flight edits. */
  function syncDomFromState(s){
    function setVal(id, v){
      const el = document.getElementById(id);
      if (el) el.value = (v == null) ? '' : String(v);
    }
    setVal('filter-price-min', s.priceMin);
    setVal('filter-price-max', s.priceMax);
    setVal('filter-area-min',  s.areaMin);
    setVal('filter-area-max',  s.areaMax);
    function setChips(cls, selected){
      const want = {};
      for (let i = 0; i < (selected || []).length; i++) want[selected[i]] = true;
      const nodes = document.querySelectorAll('input.' + cls);
      for (let i = 0; i < nodes.length; i++){
        nodes[i].checked = !!want[nodes[i].value];
      }
    }
    setChips('filter-rooms',   s.roomsSelected);
    setChips('filter-meuble',  s.meubleSelected);
    setChips('filter-term',    s.termSelected);
    setChips('filter-sources', s.sourcesSelected);
    setChips('filter-arr',     s.arrSelected);
    // Safe if the metro-line UI hasn't shipped yet — querySelectorAll returns
    // an empty list and the loop is a no-op.
    setChips('filter-line',    s.metroLinesSelected);
    const moveinEl = document.getElementById('filter-movein');
    if (moveinEl) moveinEl.checked = !!s.moveInAfter202606;
  }

  /* state → URL writer. Subscribed to FilterState, fires on every change.
     Uses history.replaceState (does NOT fire hashchange) so the writer
     never feeds back into the parser. The writingHash guard exists only for
     the fallback path where replaceState is unavailable and we must fall
     back to `location.hash =` (which DOES fire hashchange). */
  let writingHash = false;
  function writeHashFromState(s){
    if (writingHash) return;
    const body = FilterHash.serialize(s);
    let cur = '';
    try { cur = (typeof location !== 'undefined' && location.hash) || ''; } catch(e) {}
    if (body === ''){
      // State is at defaults — preserve a non-filter hash (e.g. deep-link id)
      // so the share-by-id feature isn't clobbered by an empty filter state.
      if (cur === '' || !FilterHash.isFilterHash(cur)) return;
    }
    const target = body ? ('#' + body) : '';
    if (cur === target) return;
    writingHash = true;
    try {
      if (typeof history !== 'undefined' && typeof history.replaceState === 'function'){
        const base = (location.pathname || '') + (location.search || '');
        history.replaceState(null, '', base + target);
      } else {
        // Fallback: direct assignment fires hashchange — writingHash swallows
        // the resulting restoreFromHash callback.
        location.hash = target;
      }
    } catch (e) {
      try { location.hash = target; } catch (_){}
    }
    // Release on next tick. Under modern browsers this is overkill (replaceState
    // doesn't fire hashchange) but it's the simplest correct fallback.
    setTimeout(function(){ writingHash = false; }, 0);
  }

  /* URL → state restorer. Triggered on initial load AND on every hashchange
     (back/forward navigation, manual URL edits, share-link paste). When the
     hash isn't a filter hash, the state is left alone so the legacy
     openHash() deep-link feature keeps working. */
  function restoreFromHash(){
    if (writingHash) return;
    let cur = '';
    try { cur = (typeof location !== 'undefined' && location.hash) || ''; } catch(e) {}
    if (!FilterHash.isFilterHash(cur)){
      // Empty hash on initial load: nothing to restore (state already at
      // defaults). Bare-id hash: leave state alone for openHash() to handle.
      return;
    }
    const patch = FilterHash.parse(cur);
    FilterState.replace(patch);
    // After replace fires its subscribers (applyFilters re-renders cluster,
    // writeHashFromState confirms the URL is unchanged), explicitly sync the
    // DOM controls so checkboxes and number inputs reflect the restored state.
    syncDomFromState(FilterState.get());
  }

  // Subscribe AFTER applyFilters (already subscribed at line above) so the
  // notification order is: 1) cluster re-render, 2) URL update. The reverse
  // order would also be correct but this matches "user-perceived state
  // before URL artifact" mental model.
  FilterState.subscribe(writeHashFromState);

  // hashchange → restore. The pre-existing openHash() listener also runs on
  // hashchange; the two handlers target disjoint hash formats (see the
  // isFilterHash() guard above), so both are safe to coexist.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function'){
    window.addEventListener('hashchange', restoreFromHash);
  }

  // Apply any hash that was already in the URL when the page loaded — e.g.
  // a shared link, a bookmark, or a refresh of a filtered view.
  restoreFromHash();

  // Expose for tests + future sub-ACs (metro-line UI re-uses syncDomFromState
  // for its restore path). Wrapped in try/catch because vm sandboxes may
  // restrict globalThis writes.
  try { globalThis.FilterHash = FilterHash; } catch(e) {}
  try { globalThis.__filterHashRestore = restoreFromHash; } catch(e) {}
  try { globalThis.__filterHashSyncDom = syncDomFromState; } catch(e) {}
})();

(function initRangeFilters(){
  const numIds = ['filter-price-min','filter-price-max','filter-area-min','filter-area-max'];
  function readNum(id){
    const el = document.getElementById(id);
    if (!el) return null;
    const t = el.value.trim();
    if (t === '') return null;
    const v = parseFloat(t);
    return Number.isFinite(v) ? v : null;
  }
  function readChecked(cls){
    // Returns the set of `value` attributes for checked boxes (in DOM order).
    const out = [];
    const nodes = document.querySelectorAll('input.'+cls+':checked');
    for (let i = 0; i < nodes.length; i++) out.push(nodes[i].value);
    return out;
  }
  function syncFromInputs(){
    // DOM → state. FilterState.set() notifies subscribers (applyFilters and
    // any future hash-writer / count-updater) when something actually
    // changes; identical writes are a no-op so rapid typing of the same
    // digit doesn't thrash cluster.clearLayers/addLayers.
    const moveInEl = document.getElementById('filter-movein');
    FilterState.set({
      priceMin: readNum('filter-price-min'),
      priceMax: readNum('filter-price-max'),
      areaMin:  readNum('filter-area-min'),
      areaMax:  readNum('filter-area-max'),
      roomsSelected:   readChecked('filter-rooms'),
      meubleSelected:  readChecked('filter-meuble'),
      termSelected:    readChecked('filter-term'),
      sourcesSelected: readChecked('filter-sources'),
      arrSelected:     readChecked('filter-arr'),
      moveInAfter202606: !!(moveInEl && moveInEl.checked),
      // metroLinesSelected reads input.filter-line — its DOM ships in a
      // later sub-AC, but reading it now means (a) reset clears any line
      // state inherited from a hash restore and (b) once the chips exist
      // they're picked up automatically with no schema migration.
      metroLinesSelected: readChecked('filter-line'),
    });
  }
  for (const id of numIds){
    const el = document.getElementById(id);
    if (!el) continue;
    // 'input' fires per keystroke; debounce trivially via rAF so rapid typing
    // doesn't thrash cluster.clearLayers/addLayers.
    let pending = false;
    el.addEventListener('input', () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; syncFromInputs(); });
    });
    el.addEventListener('change', syncFromInputs);
  }
  // Categorical filters: chip checkboxes + move-in toggle — change fires on every toggle.
  // input.filter-line is wired here too (its DOM ships in this AC) so toggling
  // a metro-line chip flows through syncFromInputs → FilterState.set →
  // applyFilters/writeHashFromState exactly like every other categorical axis.
  const checkboxes = document.querySelectorAll(
    'input.filter-rooms, input.filter-meuble, input.filter-term, input.filter-sources, input.filter-arr, input.filter-line, input.filter-movein'
  );
  for (let i = 0; i < checkboxes.length; i++){
    checkboxes[i].addEventListener('change', syncFromInputs);
  }
  const resetBtn = document.getElementById('filter-reset');
  if (resetBtn){
    resetBtn.addEventListener('click', () => {
      for (const id of numIds){
        const el = document.getElementById(id);
        if (el) el.value = '';
      }
      // Uncheck every checkbox inside the sidebar — covers chip-groups
      // (rooms, meuble, sources) and the single move-in toggle in one sweep.
      const allBoxes = document.querySelectorAll('#sidebar-content input[type="checkbox"]');
      for (let i = 0; i < allBoxes.length; i++) allBoxes[i].checked = false;
      syncFromInputs();
    });
  }
  // Initial paint — no filters active yet. Route through applyFilters so the
  // count display and cluster contents are always derived from the same
  // FilterState snapshot (no chance of drift between them).
  applyFilters(FilterState.get());
})();
</script>
</body>
</html>
"""


KML_HEAD = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>__KML_NAME__</name>
<description><![CDATA[자동 갱신: __LAST_CHECK__ · __N__건 · __SOURCES__]]></description>
<Style id="pass-bbs2"><IconStyle><color>ff34a853</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href></Icon></IconStyle></Style>
<Style id="ambiguous-bbs2"><IconStyle><color>ff04bcfb</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/ylw-circle.png</href></Icon></IconStyle></Style>
<Style id="pass-bbs3"><IconStyle><color>ff34a853</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/grn-diamond.png</href></Icon></IconStyle></Style>
<Style id="ambiguous-bbs3"><IconStyle><color>ff04bcfb</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/ylw-diamond.png</href></Icon></IconStyle></Style>
<Style id="pass-pap"><IconStyle><color>ff34a853</color><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/grn-stars.png</href></Icon></IconStyle></Style>
<Style id="ambiguous-pap"><IconStyle><color>ff04bcfb</color><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/ylw-stars.png</href></Icon></IconStyle></Style>
"""

KML_TAIL = "</Document>\n</kml>\n"


def kml_escape(s: str) -> str:
    return htmllib.escape(s or "", quote=False)


def kml_style_for(d: dict) -> str:
    """Pick KML <Style id> based on (verdict, source)."""
    verdict = "pass" if d.get("verdict") == "pass" else "ambiguous"
    source = d.get("source", "francezone-bbs2")
    if source == "francezone-bbs3":
        suffix = "bbs3"
    elif source == "pap":
        suffix = "pap"
    else:
        suffix = "bbs2"
    return f"{verdict}-{suffix}"


def kml_placemark(d: dict) -> str:
    style = kml_style_for(d)
    photo = (
        f'<img src="{kml_escape(d.get("photo_url",""))}" width="280"><br>'
        if d.get("photo_url")
        else ""
    )
    move_in = d.get("move_in") or "미기재"
    area = f'{d["area_m2"]}m²' if d.get("area_m2") is not None else "면적 미기재"
    price = f'{d["price_eur"]}€/월' if d.get("price_eur") is not None else "가격 미기재"
    body_excerpt = kml_escape(d.get("raw_body_excerpt", ""))[:400]
    ambig = (
        f'<p style="color:#b06000">⚠️ 모호: {kml_escape(", ".join(d.get("ambiguous_axes",[])))}</p>'
        if d.get("ambiguous_axes")
        else ""
    )
    src_label = SOURCE_LABEL.get(d.get("source", ""), "")
    src_tag = f'<p style="font-size:11px;color:#225">{kml_escape(src_label)}</p>' if src_label else ""
    desc = (
        f"<![CDATA["
        f"{src_tag}"
        f"<p><b>{area} · {price}</b></p>"
        f"<p>📍 {kml_escape(d.get('location_text',''))}<br>"
        f"🗓️ 입주: {kml_escape(move_in)}</p>"
        f"{photo}"
        f"{ambig}"
        f"<p><a href='{kml_escape(d['url'])}'>🔗 원글</a></p>"
        f"<p style='font-size:11px;color:#555'>{body_excerpt}</p>"
        f"]]>"
    )
    name = kml_escape(f"{d['title']} ({area} · {price})")
    return (
        f"<Placemark><styleUrl>#{style}</styleUrl>"
        f"<name>{name}</name>"
        f"<description>{desc}</description>"
        f"<ExtendedData>"
        f'<Data name="post_id"><value>{kml_escape(str(d["post_id"]))}</value></Data>'
        f'<Data name="source"><value>{kml_escape(d.get("source",""))}</value></Data>'
        f'<Data name="area_m2"><value>{kml_escape(str(d.get("area_m2","")))}</value></Data>'
        f'<Data name="price_eur"><value>{kml_escape(str(d.get("price_eur","")))}</value></Data>'
        f'<Data name="move_in"><value>{kml_escape(str(move_in))}</value></Data>'
        f"</ExtendedData>"
        f"<Point><coordinates>{d['lng']},{d['lat']},0</coordinates></Point>"
        f"</Placemark>\n"
    )


def load_listings(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    out = []
    seen_keys = set()
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Dedupe by namespaced_id (preferred) or fall back to (source, post_id)
            key = d.get("namespaced_id") or f"{d.get('source','?')}:{d.get('post_id')}"
            if key in seen_keys:
                continue
            if d.get("lat") is None or d.get("lng") is None:
                continue
            seen_keys.add(key)
            out.append(d)
    return _collapse_by_fingerprint(out)


def _recency_key(d: dict) -> tuple:
    """Sort key for 'most recent' within a fingerprint group. post_date
    (YYYY-MM-DD, present on francezone reposts) dominates; fetched_at ISO
    breaks ties (and orders pap cards, which carry no post_date)."""
    return (str(d.get("post_date") or ""), str(d.get("fetched_at") or ""))


def _collapse_by_fingerprint(listings: list[dict]) -> list[dict]:
    """Collapse repost/cross-listing duplicates to one pin per unit.

    Groups by `dedup.fingerprint_of` (zip|area|price|rooms) and keeps only
    the most recent listing in each group. Listings without a fingerprint
    (missing zip/area/price) are passed through untouched — never merged on
    weak evidence. Original input order is preserved for the survivors.
    """
    if fingerprint_of is None:
        return listings
    # First pass: pick the most-recent listing per fingerprint.
    best: dict[str, dict] = {}
    for d in listings:
        fp = fingerprint_of(d)
        if not fp:
            continue
        if fp not in best or _recency_key(d) > _recency_key(best[fp]):
            best[fp] = d
    # Second pass: rebuild in original order. A fingerprinted group emits its
    # winner once, at the group's first appearance; un-fingerprinted listings
    # pass through untouched (never merged on weak evidence).
    result: list[dict] = []
    emitted: set[str] = set()
    for d in listings:
        fp = fingerprint_of(d)
        if not fp:
            result.append(d)
        elif fp not in emitted:
            result.append(best[fp])
            emitted.add(fp)
    return result


def make_title_and_footer(listings: list[dict]) -> tuple[str, str, str]:
    counts = Counter(d.get("source", "unknown") for d in listings)
    parts_friendly = []
    parts_short = []
    for src in ("francezone-bbs2", "francezone-bbs3", "pap"):
        if counts.get(src):
            parts_friendly.append(SOURCE_FRIENDLY[src])
            parts_short.append(f"{SOURCE_LABEL[src]}: {counts[src]}")
    if not parts_friendly:
        parts_friendly = ["francezone"]
    title = "파리 부동산 — " + " + ".join(parts_friendly)
    footer = f"{len(listings)}건 매물 ({' · '.join(parts_short)}) · 마지막 업데이트 "
    sources_csv = ", ".join(parts_short)
    return title, footer, sources_csv


def render_html(listings: list[dict], out_path: str, last_check: str) -> None:
    payload = json.dumps(listings, ensure_ascii=False)
    title, footer, _ = make_title_and_footer(listings)
    out = (
        LEAFLET_TEMPLATE
        .replace("__LISTINGS_JSON__", payload)
        .replace("__SOURCE_LABEL_JSON__", json.dumps(SOURCE_LABEL, ensure_ascii=False))
        .replace("__TITLE__", htmllib.escape(title))
        .replace("__FOOTER__", htmllib.escape(footer) + htmllib.escape(last_check))
    )
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(out)


def render_kml(listings: list[dict], out_path: str, last_check: str) -> None:
    title, _, sources_csv = make_title_and_footer(listings)
    head = (
        KML_HEAD
        .replace("__KML_NAME__", kml_escape(title))
        .replace("__LAST_CHECK__", kml_escape(last_check))
        .replace("__N__", str(len(listings)))
        .replace("__SOURCES__", kml_escape(sources_csv))
    )
    parts = [head]
    for d in listings:
        parts.append(kml_placemark(d))
    parts.append(KML_TAIL)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("".join(parts))


def main() -> None:
    if len(sys.argv) != 5:
        print("usage: render_map.py <listings.jsonl> <out.html> <out.kml> <last_check_iso>")
        sys.exit(2)
    listings_path, html_path, kml_path, last_check = sys.argv[1:5]
    listings = load_listings(listings_path)
    render_html(listings, html_path, last_check)
    render_kml(listings, kml_path, last_check)
    counts = Counter(d.get("source", "?") for d in listings)
    print(json.dumps({"count": len(listings), "by_source": dict(counts), "html": html_path, "kml": kml_path}))


if __name__ == "__main__":
    main()
