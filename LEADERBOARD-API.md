# Lestvica: navodila za backend

Igra je statična stran in že ima celoten vmesnik za lestvico (obrazec in seznam). Manjka le strežnik, ki shranjuje vpise.

Dokler strežnik ni povezan, igra deluje v **testnem načinu**: vpisi se shranjujejo samo v brskalnik igralca (`localStorage`).

## Povezava

V [`js/leaderboard.js`](js/leaderboard.js) nastavi:

```js
var API_URL = 'https://api.example.si/4xproti';
```

Drugih sprememb v igri ni treba narediti.

## Endpointi

Vsi odgovori so JSON. Strežnik mora dovoliti CORS za domeno, kjer teče igra (npr. `https://<uporabnik>.github.io`).

### `GET /scores?limit=10`

Vrne najboljše rezultate, urejene od najboljšega navzdol. Pri enakem številu točk je prej tisti, ki je bil vpisan prej.

```json
[
  { "id": "abc123", "nickname": "Mojca", "message": "Se vidimo v nedeljo!", "score": 20000, "createdAt": "2026-10-08T10:15:00Z" }
]
```

### `POST /scores`

Telo zahteve:

```json
{
  "nickname": "Mojca",
  "message": "Se vidimo v nedeljo!",
  "score": 20000,
  "level": 5,
  "durationSeconds": 104,
  "mode": "timed",
  "clientId": "3f1c…"
}
```

| Polje | Opis |
|---|---|
| `nickname` | 1–20 znakov: črke, številke, presledek, `.`, `_`, `-` |
| `message` | 0–100 znakov, lahko prazen niz |
| `score` | celo število točk |
| `level` | dosežen nivo |
| `durationSeconds` | dejansko trajanje igre (90 s + bonusi po 4 s za vsako 4X PROTI ploščico) |
| `mode` | vedno `"timed"`, ker se Zen način ne vpisuje |
| `clientId` | naključen ID naprave, shranjen v `localStorage`; uporabi ga za omejevanje števila vpisov |

Uspešen odgovor (`200`/`201`):

```json
{ "id": "abc123", "rank": 14, "total": 230 }
```

`rank` je uvrstitev tega vpisa na celotni lestvici. Igra ga izpiše kot »Si na 14. mestu!« in vpis obarva, če je med najboljšimi 10.

Napaka (`4xx`):

```json
{ "error": "Vzdevek vsebuje neprimerne besede." }
```

Besedilo v `error` se prikaže igralcu dobesedno, zato naj bo v slovenščini.

## Kaj mora preveriti strežnik

Preverjanje v brskalniku je samo za udobje igralca, saj ga lahko kdorkoli zaobide. Strežnik mora zato sam ponoviti naslednje:

1. **Dolžine in znake** za `nickname` in `message`, kot v tabeli zgoraj. Presledke na začetku in koncu odreži.
2. **Filter neprimernih besed.** Seznam in normalizacija (male črke, odstranjene strešice, `0→o`, `1→i` …, strnjene ponovljene črke) sta v [`js/filter.js`](js/filter.js). Najlažje je to logiko prenesti 1:1.
3. **Povezave** v sporočilu niso dovoljene (`http`, `www.`, `.si`, `.com` …).
4. **Smiselnost rezultata.** Zavrni negativne ali nemogoče vrednosti, npr. `score` večji od neke zgornje meje glede na `durationSeconds`. Mejo je najbolje določiti iz prvih pravih podatkov. Za grobo omejitev lahko za začetek vzameš `score <= durationSeconds * 1000`.
5. **Omejitev števila vpisov**, npr. največ 5 vpisov na `clientId` ali IP na uro.
6. **Moderacija.** Administrator mora imeti možnost vpis skriti ali izbrisati.

## Zasebnost

Shranjujejo se samo vzdevek, sporočilo, točke in čas vpisa. IP in `clientId` uporabljaj samo za omejevanje vpisov in ju ne prikazuj javno.
