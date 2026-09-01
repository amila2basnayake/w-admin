/**
 * The BOM outlook site catalogue: the grid points the advisor queries BOM's ACCESS-S outlook at,
 * and the pure name-matching helpers used to resolve free text / CRM region names to a site.
 *
 * Shared by the refresh scripts (which fetch these points), climate-outlook.ts (which matches
 * against the snapshot's copy of this list), and build-region-site-map.ts (which resolves every
 * CRM region to a site). Keep it dependency-free — it is imported both by the sidecar and by
 * child-process scripts.
 *
 * Design: inflow catchments lead — storage inflow sets the resource and therefore allocations;
 * irrigation districts are demand-side context. Coverage spans every system Waterfind trades, not
 * just the Murray-Darling Basin: QLD coastal schemes (SunWater), Tasmania, WA groundwater areas,
 * SA groundwater PWAs and the coastal NSW/VIC systems all carry tradeable regions in the CRM, and
 * a region the matcher cannot place gets no rainfall outlook at all (audited 2026-08-06: 1,168 of
 * 1,558 regions were unmatched under the old 16-site MDB-only list).
 *
 * `valleys` are lowercase keywords matched WHOLE-WORD in both directions against a query or region
 * name (see hasWord) — short ones like "sa" and "md" rely on that. When adding keywords, check for
 * cross-system collisions first (e.g. VIC "Serpentine" vs WA "Serpentine", TAS "Clyde" vs NSW
 * "Clyde" — both were left out deliberately; coordinates map those regions instead).
 */

export type SiteRole = 'inflow_catchment' | 'irrigation_district';
export type SiteDef = {
  key: string; name: string; role: SiteRole;
  lat: number; lon: number; valleys: string[];
};

export const SITES: SiteDef[] = [
  // --- southern MDB inflow catchments (drive Hume/Dartmouth/Eildon/Burrinjuck) ---------------
  { key: 'upper-murray', name: 'Upper Murray — Dartmouth/Hume inflow catchment', role: 'inflow_catchment',
    lat: -36.50, lon: 147.50,
    valleys: ['murray', 'vic murray', 'nsw murray', 'hume', 'dartmouth', 'mitta', 'kiewa',
              'torrumbarry', 'kerang', 'cohuna', 'gunbower', 'barmah'] },
  { key: 'ovens-king', name: 'Ovens and King headwaters', role: 'inflow_catchment',
    lat: -36.80, lon: 146.80, valleys: ['ovens', 'king'] },
  { key: 'goulburn-upper', name: 'Upper Goulburn — Lake Eildon inflow catchment', role: 'inflow_catchment',
    lat: -37.20, lon: 146.00, valleys: ['goulburn', 'eildon', 'broken', 'yea', 'acheron'] },
  { key: 'campaspe-loddon', name: 'Campaspe and Loddon headwaters (Eppalock/Cairn Curran)', role: 'inflow_catchment',
    lat: -37.00, lon: 144.35,
    valleys: ['campaspe', 'loddon', 'coliban', 'eppalock', 'cairn curran', 'bullarook',
              'boort', 'pyramid hill', 'laanecoorie', 'tullaroop', 'bendigo'] },
  { key: 'murrumbidgee-upper', name: 'Upper Murrumbidgee — Burrinjuck/Blowering inflow catchment', role: 'inflow_catchment',
    lat: -35.30, lon: 148.50,
    valleys: ['murrumbidgee', 'burrinjuck', 'blowering', 'tumut', 'yanco', 'billabong', 'gundagai', 'yass', 'wagga'] },
  { key: 'lachlan-upper', name: 'Upper Lachlan — Wyangala inflow catchment', role: 'inflow_catchment',
    lat: -33.97, lon: 148.98,
    valleys: ['lachlan', 'wyangala', 'jemalong', 'lv', 'belubula', 'cargelligo', 'forbes', 'cowra', 'young'] },
  // --- northern MDB inflow catchments --------------------------------------------------------
  { key: 'macquarie-upper', name: 'Upper Macquarie — Burrendong inflow catchment', role: 'inflow_catchment',
    lat: -32.67, lon: 149.10,
    valleys: ['macquarie', 'burrendong', 'mqv', 'cudgegong', 'bogan', 'nyngan', 'castlereagh', 'coonamble',
              'dubbo', 'talbragar', 'lawsons', 'mudgee'] },
  { key: 'namoi-upper', name: 'Upper Namoi — Keepit/Split Rock inflow catchment', role: 'inflow_catchment',
    lat: -30.88, lon: 150.50,
    valleys: ['namoi', 'keepit', 'split rock', 'nv', 'peel', 'chaffey', 'mooki', 'quirindi',
              'gunnedah', 'boggabri', 'manilla', 'currabubula'] },
  { key: 'gwydir-upper', name: 'Upper Gwydir — Copeton inflow catchment', role: 'inflow_catchment',
    lat: -29.92, lon: 151.11, valleys: ['gwydir', 'copeton', 'moree', 'mehi', 'horton', 'new england'] },
  { key: 'border-rivers', name: 'Border Rivers — Pindari/Glenlyon inflow catchment', role: 'inflow_catchment',
    lat: -29.39, lon: 151.24,
    valleys: ['border rivers', 'macintyre', 'pindari', 'dumaresq', 'severn', 'stanthorpe',
              'texas', 'goondiwindi', 'quart pot', 'weir river', 'upper weir', 'callandoon'] },
  { key: 'condamine-balonne', name: 'Condamine-Balonne — Beardmore/St George', role: 'inflow_catchment',
    lat: -27.90, lon: 148.70,
    valleys: ['condamine', 'balonne', 'st george', 'beardmore', 'warrego', 'cunnamulla', 'maranoa',
              'moonie', 'culgoa', 'bokhara', 'narran', 'dirranbandi', 'thanes', 'surat'] },
  // The Condamine HEADWATERS around Toowoomba/Dalby are MDB, but sit so close to the coastal SEQ
  // sites that pure geometry mapped them to Brisbane/Lockyer (found by the 2026-08-06 domain
  // audit: the Great Dividing Range is the basin boundary, ~30km from Toowoomba). Their own site
  // keeps them on the right side of the divide AND gives them Darling Downs rainfall rather than
  // semi-arid St George.
  { key: 'condamine-headwaters', name: 'Upper Condamine — Darling Downs (Toowoomba/Dalby)', role: 'inflow_catchment',
    lat: -27.40, lon: 151.50,
    valleys: ['gowrie', 'oakey', 'dalby', 'allora', 'dalrymple', 'wilkie', 'pittsworth',
              'jondaryan', 'toowoomba', 'cecil plains', 'chinchilla', 'upper condamine',
              'leslie', 'warwick'] },
  { key: 'barwon-darling', name: 'Barwon-Darling — Menindee Lakes feed (Bourke)', role: 'inflow_catchment',
    lat: -30.09, lon: 145.94,
    valleys: ['darling', 'barwon', 'bourke', 'brewarrina', 'wilcannia', 'menindee', 'pooncarie',
              'wentworth', 'walgett'] },
  { key: 'wimmera-grampians', name: 'Wimmera — Grampians headwaters (Lake Bellfield)', role: 'inflow_catchment',
    lat: -37.10, lon: 142.50, valleys: ['wimmera', 'grampians', 'bellfield', 'horsham'] },
  // --- MDB irrigation districts (demand-side context, NOT the resource driver) ---------------
  { key: 'nsw-murray-deniliquin', name: 'NSW Murray irrigation district (Deniliquin)', role: 'irrigation_district',
    lat: -35.53, lon: 144.95,
    valleys: ['murray irrigation', 'deniliquin', 'nsw murray', 'wakool', 'west corurgan', 'corurgan',
              'berriquin', 'denimein', 'deniboota', 'moulamein', 'finley', 'jerilderie'] },
  { key: 'goulburn-shepparton', name: 'Goulburn-Murray irrigation district (Shepparton)', role: 'irrigation_district',
    lat: -36.38, lon: 145.40,
    valleys: ['shepparton', 'rochester', 'gmw', 'lower goulburn', 'katunga', 'nathalia',
              'numurkah', 'tatura', 'kyabram', 'murchison'] },
  { key: 'murrumbidgee-griffith', name: 'Murrumbidgee irrigation district (Griffith)', role: 'irrigation_district',
    lat: -34.29, lon: 146.05,
    valleys: ['griffith', 'coleambally', 'leeton', 'mi', 'hay', 'carrathool', 'darlington', 'benerembah',
              'lowbidgee', 'balranald'] },
  { key: 'sa-riverland', name: 'SA Riverland (Renmark)', role: 'irrigation_district',
    lat: -34.17, lon: 140.75,
    valleys: ['sa', 'river murray', 'riverland', 'cit', 'renmark', 'loxton', 'berri', 'waikerie',
              'pike', 'murtho', 'cadell', 'cobdogla', 'barmera', 'moorook', 'mannum',
              'murray bridge', 'mypolonga', 'qualco'] },
  { key: 'vic-mallee', name: 'Victorian Mallee / Sunraysia (Mildura)', role: 'irrigation_district',
    lat: -34.19, lon: 142.16,
    valleys: ['mallee', 'mildura', 'lmw', 'sunraysia', 'nyah', 'robinvale', 'merbein', 'red cliffs',
              'nangiloc', 'colignan', 'murrayville', 'ouyen', 'swan hill', 'curlwaa',
              'coomealla', 'buronga', 'western murray'] },
  // --- NSW outside the Basin -----------------------------------------------------------------
  { key: 'hunter-valley', name: 'Hunter Valley — Glenbawn/Glennies inflow catchment', role: 'inflow_catchment',
    lat: -32.40, lon: 151.10,
    valleys: ['hunter', 'glenbawn', 'glennies', 'wollombi', 'paterson', 'singleton', 'muswellbrook',
              'tomago', 'tomaree', 'stockton', 'great lakes'] },
  { key: 'hawkesbury-nepean', name: 'Hawkesbury-Nepean / Sydney basin (Richmond/Windsor)', role: 'irrigation_district',
    lat: -33.60, lon: 150.70,
    valleys: ['hawkesbury', 'nepean', 'grose', 'mangrove', 'mooney', 'warragamba', 'sydney',
              'botany', 'coxs river', 'brownlow', 'camden'] },
  { key: 'nsw-north-coast', name: 'NSW North Coast rivers (Clarence/Richmond/Macleay)', role: 'irrigation_district',
    lat: -30.30, lon: 152.90,
    valleys: ['north coast', 'clarence', 'richmond', 'tweed', 'macleay', 'hastings', 'manning',
              'bellinger', 'nambucca', 'lorne', 'coffs', 'woolgoolga', 'stuarts point', 'brunswick',
              'alstonville', 'dorrigo', 'comboyne', 'gloucester', 'bulahdelah'] },
  { key: 'nsw-south-coast', name: 'NSW South Coast rivers (Bega/Shoalhaven)', role: 'irrigation_district',
    lat: -36.70, lon: 149.80,
    valleys: ['south coast', 'bega', 'brogo', 'moruya', 'shoalhaven', 'towamba', 'tuross'] },
  // --- VIC outside the Basin -----------------------------------------------------------------
  { key: 'werribee-melbourne', name: 'Werribee / Melbourne systems (Bacchus Marsh)', role: 'irrigation_district',
    lat: -37.65, lon: 144.45,
    valleys: ['werribee', 'merrimu', 'bacchus marsh', 'melbourne', 'maribyrnong', 'pykes'] },
  { key: 'gippsland-macalister', name: 'Gippsland — Macalister/Thomson (Lake Glenmaggie)', role: 'irrigation_district',
    lat: -37.90, lon: 146.90,
    valleys: ['macalister', 'thomson', 'glenmaggie', 'gippsland', 'heyfield', 'maffra'] },
  { key: 'vic-southwest', name: 'South-West Victoria — Hopkins/Corangamite (Ballarat-Warrnambool)', role: 'irrigation_district',
    lat: -37.90, lon: 143.50,
    valleys: ['hopkins', 'corangamite', 'ballarat', 'warrnambool', 'otway'] },
  // --- Tasmania ------------------------------------------------------------------------------
  { key: 'tas-north', name: 'Northern Tasmania (Mersey/Meander, Devonport)', role: 'irrigation_district',
    lat: -41.35, lon: 146.40,
    // 'tasmania' deliberately absent: market names like "TASMANIAN IRRIGATION ..." span both TAS
    // sites, and a statewide keyword would pull Midlands regions north.
    valleys: ['pardoe', 'sassafras', 'northdown', 'mersey', 'meander', 'kindred', 'forth'] },
  { key: 'tas-south-esk', name: 'Northern Midlands TAS — Lower South Esk (Longford)', role: 'irrigation_district',
    lat: -41.60, lon: 147.20, valleys: ['south esk', 'longford', 'evandale'] },
  { key: 'tas-midlands', name: 'Tasmanian Midlands (Jordan/Clyde, Oatlands)', role: 'irrigation_district',
    lat: -42.35, lon: 147.30,
    valleys: ['jordan river', 'isis river', 'kittys', 'dulverton', 'woodbury', 'york plains',
              'mt seymour', 'oatlands', 'midlands', 'coal river'] },
  // --- QLD coastal schemes (SunWater / Seqwater) ---------------------------------------------
  { key: 'seq-logan-albert', name: 'SE Queensland — Logan/Albert', role: 'irrigation_district',
    lat: -28.10, lon: 153.00, valleys: ['logan', 'albert', 'beaudesert'] },
  { key: 'seq-brisbane-lockyer', name: 'SE Queensland — Brisbane/Lockyer (Wivenhoe)', role: 'irrigation_district',
    lat: -27.50, lon: 152.40,
    valleys: ['lockyer', 'brisbane', 'wivenhoe', 'somerset', 'warrill', 'moogerah', 'moreton'] },
  { key: 'mary-river', name: 'Mary River — Borumba inflow catchment (Gympie)', role: 'inflow_catchment',
    lat: -26.20, lon: 152.70, valleys: ['mary', 'borumba', 'gympie', 'tinana'] },
  { key: 'burnett-bundaberg', name: 'Burnett/Kolan — Paradise/Boondooma catchments (Bundaberg)', role: 'inflow_catchment',
    lat: -25.30, lon: 151.80,
    valleys: ['burnett', 'kolan', 'elliott', 'gin gin', 'bundaberg', 'paradise', 'boondooma',
              'barambah', 'monduran', 'bjelke', 'barker'] },
  { key: 'dawson-callide', name: 'Dawson/Callide (Theodore/Biloela)', role: 'inflow_catchment',
    lat: -24.60, lon: 150.20, valleys: ['dawson', 'callide', 'theodore', 'biloela', 'moura', 'kroombit'] },
  { key: 'fitzroy-mackenzie', name: 'Fitzroy/Mackenzie — Fairbairn catchment (Emerald)', role: 'inflow_catchment',
    lat: -23.20, lon: 148.10, valleys: ['fitzroy', 'mackenzie', 'nogoa', 'comet', 'emerald', 'fairbairn'] },
  { key: 'pioneer-mackay', name: 'Pioneer/Teemburra (Mackay)', role: 'irrigation_district',
    lat: -21.10, lon: 148.90,
    // 'andromache' lives here, not on burdekin: the Andromache R is an O'Connell tributary
    // (coastal Whitsunday/Mackay), and its downstream O'Connell zones map here too.
    valleys: ['pioneer', 'teemburra', 'cattle', 'mackay', 'eton', 'marian', 'mirani', 'connell',
              'andromache'] },
  { key: 'burdekin-haughton', name: 'Burdekin/Haughton (Ayr) incl. Whitsunday coastal systems', role: 'irrigation_district',
    lat: -19.90, lon: 147.25,
    // 'bowen broken' beats the VIC 'broken' keyword via keyword-shadowing in the map builder:
    // the Bowen Broken WSS (Eungella Dam, Collinsville) is Burdekin basin, not the VIC Broken R.
    valleys: ['burdekin', 'haughton', 'giru', 'ayr', 'proserpine', 'bowen', 'bowen broken',
              'eungella', 'collinsville', 'houghton', 'whitsunday'] },
  { key: 'barron-atherton', name: 'Barron — Tinaroo catchment (Atherton/Mareeba)', role: 'inflow_catchment',
    lat: -17.25, lon: 145.55,
    valleys: ['barron', 'tinaroo', 'mareeba', 'dimbulah', 'atherton', 'mazlin', 'md'] },
  // --- SA groundwater and non-River-Murray ---------------------------------------------------
  { key: 'mount-lofty-ranges', name: 'Mount Lofty Ranges / Barossa / McLaren Vale (Adelaide Hills)', role: 'irrigation_district',
    lat: -34.90, lon: 138.85,
    valleys: ['barossa', 'mclaren vale', 'torrens', 'onkaparinga', 'para', 'finniss', 'angas',
              'marne', 'willunga', 'langhorne', 'currency creek', 'clare', 'noarlunga',
              'mount lofty', 'adelaide', 'bungaree'] },
  { key: 'sa-limestone-coast', name: 'SA Limestone Coast (Padthaway/Naracoorte)', role: 'irrigation_district',
    lat: -37.00, lon: 140.80,
    valleys: ['tatiara', 'padthaway', 'naracoorte', 'coonawarra', 'limestone coast', 'comaum',
              'lacepede', 'mount gambier', 'kingston', 'tintinara', 'coonalpyn', 'peake'] },
  // --- WA / NT / remote QLD ------------------------------------------------------------------
  { key: 'wa-southwest', name: 'WA South-West / Perth groundwater areas', role: 'irrigation_district',
    lat: -32.30, lon: 116.00,
    // 'south west dams' (not bare 'south west'): Victoria's Southern Rural Water runs a
    // "SOUTH WEST LIMESTONE" GMA at Warrnambool, and the bare phrase dragged it to Perth.
    valleys: ['gnangara', 'jandakot', 'collie', 'harvey', 'waroona', 'wanneroo', 'mirrabooka',
              'perth', 'leederville', 'busselton', 'capel', 'swan valley', 'south west dams',
              'metropolitan dams', 'great southern'] },
  { key: 'wa-pilbara', name: 'WA Pilbara groundwater areas', role: 'irrigation_district',
    lat: -21.20, lon: 117.50, valleys: ['pilbara', 'ashburton', 'west canning', 'north west dams'] },
  { key: 'ord-river', name: 'Ord River scheme (Kununurra/Lake Argyle)', role: 'inflow_catchment',
    lat: -15.90, lon: 128.75, valleys: ['ord', 'kununurra', 'argyle'] },
  { key: 'nt-katherine', name: 'NT Katherine — Daly/Tindall groundwater', role: 'irrigation_district',
    lat: -14.47, lon: 132.26, valleys: ['katherine', 'tindall', 'oolloo', 'daly'] },
  { key: 'nw-qld-mount-isa', name: 'NW Queensland — Leichhardt/Lake Julius (Mount Isa)', role: 'inflow_catchment',
    lat: -20.60, lon: 139.60, valleys: ['julius', 'leichhardt', 'mount isa', 'cloncurry'] },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word containment. Plain substring matching is WRONG here: short valley keywords like "sa"
 *  and "mi" occur inside unrelated region names ("BAROSSA - EAST PARA ZONE" contains "sa"), which
 *  silently attached the SA Riverland forecast to a Barossa groundwater region. A misattributed
 *  catchment forecast is worse than none, so both directions require word boundaries. */
export function hasWord(haystack: string, needle: string): boolean {
  const n = needle.trim();
  if (!n) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(n)}([^a-z0-9]|$)`, 'i').test(haystack);
}

const ci = (s: unknown) => String(s ?? '').toLowerCase();

/** Match free text against a site list (the catalogue above, or the snapshot's copy of it).
 *  Pure so the map builder and the snapshot reader share one matching semantics. */
export function matchSitesIn<T extends Pick<SiteDef, 'key' | 'name' | 'valleys'>>(
  sites: T[], query?: string): T[] {
  const q = ci(query).trim();
  if (!q) return sites;
  return sites.filter((s) =>
    ci(s.key) === q || ci(s.name).includes(q) ||
    s.valleys.some((v) => hasWord(q, ci(v)) || hasWord(ci(v), q)));
}

/** Great-circle distance in km — used by the region-site map builder to attach regions whose names
 *  carry no geography (e.g. "ZONE KB - CLASS 1K") via their linked dam/weather-station coords. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** Nearest site to a coordinate, with distance. */
export function nearestSite(lat: number, lon: number): { site: SiteDef; km: number } {
  let best = SITES[0], bestKm = Infinity;
  for (const s of SITES) {
    const km = haversineKm(lat, lon, s.lat, s.lon);
    if (km < bestKm) { best = s; bestKm = km; }
  }
  return { site: best, km: Math.round(bestKm) };
}
