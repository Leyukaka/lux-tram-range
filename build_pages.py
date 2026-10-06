"""Generate static Luxembourg pages in three languages."""
import hashlib
import html
import json
import os
from pathlib import Path
from string import Template
from cities import load_cities

ROOT = Path(__file__).resolve().parent
SITE = ROOT / 'site'
SITE_NAME = 'lux-tram-range'
SITE_URL = os.environ.get('SITE_URL', 'https://lux-tram-range.workers.dev').rstrip('/')
GITHUB_URL = 'https://github.com/Leyukaka/lux-tram-range'
LICENCES = {'cc-by': ('CC-BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'), 'odbl': ('ODbL 1.0', 'https://opendatacommons.org/licenses/odbl/1-0/')}
LANGUAGES = ('fr', 'en', 'de')
esc = html.escape

def short_hash(path):
    return hashlib.sha1(path.read_bytes()).hexdigest()[:8] if path.exists() else '0'

def translations(lang):
    reference = json.loads((ROOT / 'i18n/fr.json').read_text(encoding='utf-8'))
    return {**reference, **json.loads((ROOT / f'i18n/{lang}.json').read_text(encoding='utf-8'))}

def path_for(lang, page=''):
    return '/' + (lang + '/' if lang != 'fr' else '') + page

def render(lang, page, title, body, config=None):
    texts = translations(lang)
    alternates = ''.join(f'<link rel="alternate" hreflang="{code}" href="{SITE_URL}{path_for(code, page)}">' for code in LANGUAGES)
    switch = ' '.join(f'<a data-language href="{path_for(code, page)}" lang="{code}" hreflang="{code}">{code.upper()}</a>' for code in LANGUAGES)
    head = f'<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{esc(title)}</title><meta name="description" content="{esc(texts["description"])}"><link rel="canonical" href="{SITE_URL}{path_for(lang, page)}">{alternates}<link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/styles.css?v={short_hash(SITE / "styles.css")}">'
    header = f'<header class="site-header"><a href="{path_for(lang)}">{esc(texts["site_title"])}</a><nav aria-label="{esc(texts["languages"])}">{switch}</nav></header>'
    footer = f'<footer class="site-footer"><p><a href="{path_for(lang, "mentions-legales/")}">{esc(texts["legal_title"])}</a> · <a href="{GITHUB_URL}">{esc(texts["source_code"])}</a></p><p>{texts["credits"]}</p><p>{texts["translation_notice"]}</p></footer>'
    blob = json.dumps({'fallback': translations('fr'), 'messages': texts}, ensure_ascii=False).replace('</', '<\\/')
    scripts = f'<script id="i18n" type="application/json">{blob}</script>'
    if config:
        scripts += '<script id="city-config" type="application/json">' + json.dumps(config, ensure_ascii=False).replace('</', '<\\/') + '</script>'
        scripts += f'<script type="module" src="/app.js?v={short_hash(SITE / "app.js")}"></script>'
    scripts += '<script>document.querySelectorAll("a[data-language]").forEach(a=>a.addEventListener("click",()=>{a.search=location.search;}));</script>'
    return f'<!doctype html><html lang="{lang}"><head>{head}</head><body>{header}<main class="page">{body}</main>{footer}{scripts}</body></html>'

def faq(texts, sources=None):
    content = ''.join(f'<details><summary>{esc(texts[key + "_q"])}</summary><p>{texts[key + "_a"]}</p></details>' for key in ('method', 'bus', 'sources', 'limits'))
    if sources:
        gtfs = sources['gtfs']
        period = gtfs.get('servicePeriod') or []
        detail = texts['reference'].format(date=sources['referenceDate'], period=' - '.join(str(v) for v in period), fetched=gtfs.get('fetchedAt', ''))
        content += f'<p>{esc(detail)}</p>'
    return f'<section class="section"><h2>{esc(texts["faq"])}</h2>{content}</section>'

def render_city(city, cities, lang):
    texts = translations(lang)
    sources = json.loads((ROOT / 'sources' / f'{city["slug"]}.json').read_text(encoding='utf-8'))
    stats = sources['stats']
    data = json.loads((SITE / 'data' / f'{city["slug"]}.json').read_text(encoding='utf-8'))
    lines = stats['lines']
    fastest = min(lines, key=lambda line: line['headway'])
    labels = [(f'{stats["within30"]} %', texts['stat_reach'].format(center=stats['center'])), (str(stats['railStations']), texts['rail_stations']), (texts['minutes'].format(n=f'{fastest["headway"]:g}'), texts['stat_frequency'].format(line=fastest['name'])), (texts['minutes'].format(n=stats['farthestMinutes']), texts['stat_farthest'].format(station=stats['farthestStation']))]
    tiles = ''.join(f'<div class="stat"><strong>{esc(value)}</strong><span>{esc(label)}</span></div>' for value, label in labels)
    rows = []
    for line in lines:
        info = line if line.get('longName') else next((info for info in data['routeInfo'].values() if info['name'] == line['name'] and info['mode'] == line['mode']), line)
        color = line['color']
        value = int(color.lstrip('#'), 16)
        foreground = '#111' if .299 * (value >> 16) + .587 * ((value >> 8) & 255) + .114 * (value & 255) > 150 else '#fff'
        rows.append(f'<tr><td><span class="line-badge" title="{esc(info.get("longName", line["name"]))}" style="background:{esc(color)};color:{foreground}">{esc(line["name"])}</span> {esc(info.get("longName") or texts["mode_" + line["mode"]])}</td><td>{line["stations"]}</td><td>~{esc(texts["minutes"].format(n=f'{line["headway"]:g}'))}</td></tr>')
    items = ''.join(f'<a class="city-item" data-name="{esc(other["name"])}" href="{path_for(lang, other["path"])}">{esc(other["name"])}</a>' for other in cities)
    others = ''.join(f'<a href="{path_for(lang, other["path"])}">{esc(other["name"])}</a>' for other in cities if other['slug'] != city['slug'])
    values = {key: esc(value) for key, value in texts.items()}
    values.update(name=esc(city['name']), headline=esc(texts['map_title'].format(name=city['name'])), city_items=items, search_placeholder=esc(texts['search_placeholder'].format(example=city['searchExample'])), stat_tiles=tiles, line_rows=''.join(rows), faq_html=faq(texts, sources), other_maps=others, stats_title=esc(texts['stats_title'].format(name=city['name'])), network=esc(city['network']))
    body = Template((ROOT / 'templates/city.html').read_text(encoding='utf-8')).substitute(values)
    config = {key: city[key] for key in ('slug', 'name', 'defaultFrom', 'areaKey', 'defaultMax', 'scaleMax') if key in city}
    config.update(dataVersion=short_hash(SITE / 'data' / f'{city["slug"]}.json'), railNoun=texts['rail_noun'], railStations=texts['rail_stations'], busNoun=texts['mode_bus'])
    return render(lang, city['path'], texts['map_title'].format(name=city['name']), body, config)

def main():
    cities = load_cities()
    urls = []
    for lang in LANGUAGES:
        texts = translations(lang)
        cards = ''.join(f'<a class="city-card" href="{path_for(lang, city["path"])}"><h2>{esc(texts["map_" + city["areaKey"]])}</h2><p>{esc(city["name"])}</p></a>' for city in cities)
        home = Template((ROOT / 'templates/home.html').read_text(encoding='utf-8')).substitute(site_title=esc(texts['site_title']), description=esc(texts['description']), city_cards=cards, faq_html=faq(texts))
        pages = {'': render(lang, '', texts['site_title'], home), 'mentions-legales/': render(lang, 'mentions-legales/', texts['legal_title'], f'<h1>{esc(texts["legal_title"])}</h1><p>{texts["legal_text"]}</p><p>{texts["licences"]}</p>')}
        for city in cities:
            pages[city['path']] = render_city(city, cities, lang)
        for page, content in pages.items():
            output = SITE / path_for(lang, page).lstrip('/') / 'index.html'
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(content, encoding='utf-8')
            urls.append(SITE_URL + path_for(lang, page))
        error = render(lang, '404.html', texts['not_found'], f'<h1>{esc(texts["not_found"])}</h1><a href="{path_for(lang)}">{esc(texts["home"])}</a>')
        (SITE / path_for(lang, '404.html').lstrip('/')).write_text(error, encoding='utf-8')
    (SITE / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + ''.join(f'<url><loc>{esc(url)}</loc></url>' for url in urls) + '</urlset>', encoding='utf-8')
    (SITE / 'robots.txt').write_text(f'User-agent: *\nAllow: /\nSitemap: {SITE_URL}/sitemap.xml\n', encoding='utf-8')

if __name__ == '__main__':
    main()
