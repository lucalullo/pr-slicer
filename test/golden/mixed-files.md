# Piano PR Slicer

**Suddivisione da verificare**

Base: `3d513a422b952da4b444d6e1d21189840aff0d0d`  
Head: `b9c3294458cab837a12d10a1591149f280ef01b7`

## Fatti osservati

- 3 file, 3 unità, 0 relazioni.
- Ricostruzione finale identica al tree head: `d955910222876e45794dd519ccd6bed62efb25a7`.
- Analisi: deep.

## Gruppi e inferenze strutturali

### 1. Aggiorna a.ts

ID: `slice_0957cffa90cd427d` · 1 file · +1/−1

Dipendenze: nessuna

- a.ts

- Segmento contiguo di un ordine che rispetta le dipendenze note; dimensione, package, aree e affinità determinano il costo.

### 2. Aggiorna image.bin (2 file)

ID: `slice_3771ec483f44b6a5` · 2 file · +1/−0

Dipendenze: nessuna

- image.bin
- notes.md

- Segmento contiguo di un ordine che rispetta le dipendenze note; dimensione, package, aree e affinità determinano il costo.

## Verifiche eseguite

Stato: **not-run** · livello: **reconstructed**

| Gruppo | Controllo | Esito | Dettaglio |
|---|---|---|---|
| — | Ricostruzione finale | passed | Build, test e diagnostica dei prefissi non eseguiti |

## Metriche

| Metrica | Valore |
|---|---|
| Revisionabilità | 100/100 |
| Coesione strutturale | 100/100 |
| Integrità dipendenze | 100/100 |
| Confidenza dei confini | low |

Le metriche sono euristiche strutturali, non probabilità di correttezza.

## Alternative statiche

- `candidate_47107f917fdd0a19`: 2 gruppi, costo 16.
- `candidate_814f2bdb7220ac48`: 1 gruppi, costo 16.75.
- `candidate_c0780915ccfb6003`: 3 gruppi, costo 26.5.

## Limiti e incertezze

- Excluded from semantic analysis; the complete file change remains in the reconstruction.
- Excluded from semantic analysis; the complete file change remains in the reconstruction.
- One or both snapshots have no TypeScript/JavaScript project configuration; AST and direct imports are used for those files.

Il superamento dei controlli non dimostra la correttezza assoluta del comportamento.
