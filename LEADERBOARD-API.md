# Lestvica: navodila za backend

Strežnik je [`server/server.js`](server/server.js) in teče na isti domeni kot igra, zato je API dosegljiv na relativni poti `api/` (CORS ni potreben). Navodila za zagon, namestitev in moderacijo so v [`README.md`](README.md).

Če igro odpreš neposredno z diska (`file://`), deluje v **testnem načinu**: vpisi se shranjujejo samo v brskalnik igralca (`localStorage`).

## Endpointi

Vsi odgovori so JSON. Poti spodaj so relativne na `/api`.

### `GET /scores?limit=10&offset=0`

Vrne najboljše rezultate, urejene od najboljšega navzdol. Pri enakem številu točk je prej tisti, ki je bil vpisan prej. `limit` je največ 100, `offset` preskoči toliko prvih vpisov (za listanje in za prikaz igralcev okoli tvoje uvrstitve).

```json
[
  { "id": "abc123", "nickname": "Mojca", "message": "Se vidimo v nedeljo!", "score": 20000, "createdAt": "2026-10-08T10:15:00Z" }
]
```

### Preverjene igre

Igralec rezultata ne pošlje sam: strežnik ga izračuna tako, da igro ponovi. Igra v načinu Odštevanje teče v treh korakih.

#### 1. `POST /games`

Ob začetku igre. Telo je prazno (`{}`). Odgovor (`201`):

```json
{ "token": "…", "seed": "3f1c0a9e…" }
```

`seed` (32 šestnajstiških znakov) določa začetno ploščo in vse nove ploščice. Igra ga uporabi kot edini vir naključnosti za ploščo (`Logic.rng` v [`js/logic.js`](js/logic.js)). `token` je podpisan in vsebuje ID igre ter čas začetka; strežnik si ničesar ne zapomni.

Največ 200 iger na IP na uro (`429`).

#### 2. `POST /games/finish`

Ob koncu igre, takoj. Telo:

```json
{ "token": "…", "moves": [[3, 2, 3, 3, 1250], [0, 5, 1, 5, 2930]], "score": 20000 }
```

`moves` so odigrane zamenjave `[vrstica1, stolpec1, vrstica2, stolpec2, ms]`, kjer je `ms` stanje igralne ure (porabljen čas v milisekundah) ob zamenjavi. Neveljavne zamenjave, ki se vrnejo nazaj, se ne pošiljajo. `score` je rezultat, ki ga je videl igralec; strežnik ga ne upošteva, le zapiše v dnevnik, če se ne ujema s ponovitvijo.

Strežnik igro ponovi z isto kodo kot brskalnik (`Logic.replay`) in preveri:

1. da je vsaka zamenjava veljavna na plošči, ki jo da `seed`,
2. da je vsaka zamenjava pred iztekom časa (90 s + 4 s za vsako 4X PROTI ploščico, dobljeno do tedaj),
3. da si zamenjave ne sledijo hitreje, kot to dopuščajo animacije (najhitrejša nastavitev, tj. zmanjšano gibanje, z 10 % rezerve),
4. da zadnja zamenjava ni kasnejša od dejanskega časa, ki je minil od začetka igre (+2 s),
5. da igra ni bila zaključena več kot 2 minuti po izteku svojega časa. Tako nihče ne more dolgo preračunavati plošče, ki jo pozna vnaprej.

Odgovor (`200`):

```json
{ "receipt": "…", "score": 20000, "level": 5 }
```

`receipt` je podpisano potrdilo z ID-jem igre, rezultatom, nivojem, trajanjem in časom zaključka. Velja 24 ur.

#### 3. `POST /scores`

Ko igralec vpiše vzdevek. Telo:

```json
{ "receipt": "…", "nickname": "Mojca", "message": "Se vidimo v nedeljo!", "clientId": "3f1c…" }
```

| Polje | Opis |
|---|---|
| `receipt` | potrdilo iz `/games/finish`; točke, nivo in trajanje se vzamejo iz njega |
| `nickname` | 1–20 znakov: črke, številke, presledek, `.`, `_`, `-` |
| `message` | 0–100 znakov, lahko prazen niz |
| `clientId` | naključen ID naprave, shranjen v `localStorage`; uporabi se za omejevanje števila vpisov |

Uspešen odgovor (`201`):

```json
{ "id": "abc123", "rank": 14, "total": 230 }
```

`rank` je uvrstitev tega vpisa na celotni lestvici. Igra ga izpiše kot »Si na 14. mestu!« in vpis obarva: med najboljšimi 5 ali pod »Ostali« skupaj z dvema igralcema nad in pod njim.

Vsaka igra gre na lestvico le enkrat (`409`).

Napaka (`4xx`):

```json
{ "error": "Vzdevek vsebuje neprimerne besede." }
```

Besedilo v `error` se prikaže igralcu dobesedno, zato naj bo v slovenščini.

## Kaj preveri strežnik

Preverjanje v brskalniku je samo za udobje igralca, saj ga lahko kdorkoli zaobide. Strežnik zato sam ponovi naslednje:

1. **Rezultat** dobi samo iz ponovitve igre (glej zgoraj), nikoli od igralca.
2. **Dolžine in znake** za `nickname` in `message`, kot v tabeli zgoraj. Presledke na začetku in koncu odreže.
3. **Filter neprimernih besed.** Seznam in normalizacija (male črke, odstranjene strešice, `0→o`, `1→i` …, strnjene ponovljene črke) sta v [`js/filter.js`](js/filter.js).
4. **Povezave** v sporočilu niso dovoljene (`http`, `www.`, `.si`, `.com` …).
5. **Omejitev števila vpisov**: največ 5 vpisov na `clientId` ali IP na uro.
6. **Moderacija.** Administrator lahko vpis skrije ali izbriše.

Ponovitev zagotovi, da je rezultat mogoče doseči v pravi igri. Ne prepreči pa bota, ki igra sam, kolikor hitro dopuščajo pravila. Takšne vpise je treba skriti ročno.

## Zasebnost

Shranjujejo se samo vzdevek, sporočilo, točke, stopnja, trajanje igre, čas vpisa in naključni ID igre (da gre vsaka igra na lestvico le enkrat). IP in `clientId` se uporabljata samo za omejevanje vpisov: strežnik ju hrani le v pomnilniku, kot zgoščeni vrednosti s soljo, ki se ob vsakem zagonu zamenja, in ju po eni uri pozabi. Ne zapiše ju v bazo ne v dnevnik.
