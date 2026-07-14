# DataManager Module Structure

This directory contains the refactored DataManager implementation, broken down into focused, maintainable modules.

## Module Overview

### `index.js` - Main Facade
The public API that wires all modules together. Use this for external imports:

```javascript
import { DataManager } from './api/dataManager/index.js';
```

**Key responsibilities:**
- Instantiates the DataManager class
- Wires dependencies between modules
- Exports a cohesive public API
- Maintains backward compatibility with the original DataManager

**Public API methods:**
- `fetchAndUpdateConfig(trackId)` - Primary method to load and configure data
- `fetchTrackData(trackId, overrides)` - Fetch track data with optional overrides
- `loadConfiguration(descriptor)` - Load from a configuration descriptor
- `loadFromHydratedSession(options)` - Load from pre-hydrated session data
- `applyConfigOverrides(overrides)` - Apply configuration changes
- `swapTrack(trackId, options)` - Switch to a different track
- `swapOrbiter(orbiterId, options)` - Switch to a different orbiter
- `swapEntangledWorld(worldId, options)` - Switch to a different world
- `populatePlaceholders(target)` - Update UI placeholders
- `updatePlaceholderConfig(trackId)` - Rebuild placeholder configuration
- `setParameterManager(manager)` - Connect to the parameter manager
- `isEditModeEnabled()` / `setEditModeEnabled(enabled)` - Edit mode state

---

### `loaders.js` - Data Fetching
Handles all raw data fetching from API endpoints, embedded authentication, and HTTP operations.

**Key exports:**
- `fetchTrackRelease(trackId, { version })` - Fetch track release data
- `fetchOrbiterRelease(orbiterId, { version })` - Fetch orbiter release data
- `fetchEntangledWorldRelease(worldId, { version })` - Fetch world release data
- `resolveStorageBase()` - Get the storage base URL
- `resolveStorageAssetURL(key)` - Convert storage keys to full URLs
- `getEmbeddedAuthToken()` - Get the current auth token
- `requestEmbeddedAuthToken()` - Request auth from parent frame

**Features:**
- Automatic caching via Constants
- Embedded auth token management via postMessage
- Automatic retry with auth request on 403 errors
- Storage URL resolution for asset keys

---

### `normalizers.js` - Data Normalization
Transforms raw API payloads into consistent internal data structures.

**Key exports:**
- `normalizeTrackRelease(payload)` - Normalize track data
- `normalizeOrbiterRelease(payload)` - Normalize orbiter data
- `normalizeWorldRelease(payload)` - Normalize world data
- `normalizeOrbiterParameters(parameters)` - Normalize parameter definitions
- `normalizeOrbiterEffects(effects)` - Normalize effect configurations

**Features:**
- Handles multiple payload formats and legacy aliases
- Applies constraints to axis parameters (x/y/z)
- Sanitizes mappings and settings
- Resolves nested metadata structures
- Validates numeric ranges and defaults

---

### `assembler.js` - Configuration Assembly
Orchestrates the fetching and combining of track, orbiter, and world data into unified configurations.

**Key exports:**
- `assembleConfig(request)` - Main orchestration method
- `effectsToStacks(effects, options)` - Convert effects to stack structure
- `resetOrbiterFallbackNotification()` - Reset fallback notification flag

**Features:**
- Fetches and combines all required data
- Applies fallback data when orbiter fetch fails
- Enriches track data with media URLs
- Resolves default entity IDs from track metadata
- Handles version-specific requests

---

### `hydration.js` - Session Hydration
Handles loading from pre-hydrated session data, cache priming, and descriptor merging.

**Key exports:**
- `loadFromHydratedSession({ trackSession, orbiterSession, entangledWorldSession, descriptor })` - Load from hydrated data

**Features:**
- Primes caches with pre-fetched data
- Merges descriptors intelligently
- Falls back to assembler for missing data
- Supports version-specific hydration

---

### `placeholders.js` - UI Placeholder Management
Manages UI placeholder configuration and population for different views.

**Key exports:**
- `buildPlaceholderConfig(track, orbiter, entangledWorld)` - Build config from data
- `populatePlaceholders(target, config)` - Update DOM elements
- `clearPlaceholders()` - Clear all placeholders
- `getParamValueFormatted(name, parameterManager, lastParamValues)` - Format parameter values

**Features:**
- Generates configs for: `monitorInfo`, `trackInfo`, `entangledWorldInfo`, `orbiterInfo`
- Smart hiding of empty/unknown values
- Supports dynamic placeholder values (functions)
- Formats parameter values for display

---

### `sessionBridge.js` - Session Communication
Wrappers for session resolution and updates via iframe communication.

**Key exports:**
- `safeResolveSession(resolution, options)` - Resolve session state
- `safeUpdateSession(patch, options)` - Update session state

**Features:**
- Safe wrappers that won't break on errors
- Handles iframe communication
- Server-side rendering compatible (skips in Node.js)

---

## Architecture Principles

### 1. **Single Responsibility**
Each module has one clear purpose:
- **Loaders** only fetch data
- **Normalizers** only transform data
- **Assembler** only orchestrates
- **Hydration** only handles pre-loaded data
- **Placeholders** only manage UI
- **Session Bridge** only handles communication

### 2. **Dependency Flow**
```
┌─────────────────────────────────────────────┐
│             index.js (Facade)               │
│  - Public API                               │
│  - Dependency wiring                        │
└─────────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
┌──────────────┐ ┌──────────┐ ┌──────────────┐
│  assembler   │ │hydration │ │ placeholders │
│  - Orchestr. │ │- Priming │ │  - UI config │
└──────────────┘ └──────────┘ └──────────────┘
        │            │
        ▼            ▼
┌──────────────┬──────────────┐
│   loaders    │  normalizers │
│  - HTTP calls│  - Transform │
└──────────────┴──────────────┘
```

### 3. **No Circular Dependencies**
- Lower-level modules (loaders, normalizers) never import from higher levels
- Assembler depends on loaders + normalizers
- Index depends on all, but nothing depends on index

### 4. **Pure Functions Where Possible**
- Normalizers are pure transformations
- Placeholder builders are pure
- Only loaders and assembler have side effects (network, cache)

---

## Usage Examples

### Basic Track Loading
```javascript
import { DataManager } from './api/dataManager/index.js';

const dm = new DataManager();
await dm.fetchAndUpdateConfig('track-123');
```

### Direct Module Access
```javascript
import { fetchTrackRelease, normalizeTrackRelease } from './api/dataManager/index.js';

const rawData = await fetchTrackRelease('track-123');
const normalized = normalizeTrackRelease(rawData);
```

### Hydrated Session Loading
```javascript
const dm = new DataManager();
await dm.loadFromHydratedSession({
  trackSession: preloadedTrack,
  orbiterSession: preloadedOrbiter,
  descriptor: { trackId: 'track-123' }
});
```

### Configuration Swapping
```javascript
// Swap to different orbiter
await dm.swapOrbiter('orbiter-456');

// Swap to different track
await dm.swapTrack('track-789', { version: 'v2.0' });
```

---

## Migration Notes

### From Old DataManager
The new structure maintains **100% backward compatibility** with the original API:

```javascript
// Old way (still works)
import { DataManager } from './api/DataManager.js';

// New way (same API)
import { DataManager } from './api/dataManager/index.js';
```

All public methods remain unchanged. The old file has been renamed to `DataManager.OLD.js` for reference.

### For Internal Refactoring
If you need to work with individual modules:

```javascript
// Import specific functionality
import { fetchTrackRelease } from './api/dataManager/loaders.js';
import { normalizeTrackRelease } from './api/dataManager/normalizers.js';
import { assembleConfig } from './api/dataManager/assembler.js';
```

---

## Testing Strategy

Each module can now be tested in isolation:

1. **Loaders** - Mock HTTP responses
2. **Normalizers** - Unit test transformations with fixtures
3. **Assembler** - Mock loaders + normalizers
4. **Placeholders** - Mock DOM elements
5. **Hydration** - Test cache priming
6. **Session Bridge** - Mock postMessage

---

## Future Improvements

Potential enhancements now that the code is modular:

1. **Loader Retry Logic** - Add exponential backoff
2. **Normalizer Validation** - Add schema validation with Zod/Yup
3. **Cache Strategy** - Make cache expiry configurable per entity type
4. **Placeholder Templates** - Extract to JSON config files
5. **Error Recovery** - More granular error handling per module
6. **Performance** - Add request deduplication
7. **TypeScript** - Gradually add type definitions per module

---

## File Size Comparison

| File | Old | New |
|------|-----|-----|
| DataManager.js | ~1200 lines | Removed |
| index.js | - | ~400 lines |
| loaders.js | - | ~340 lines |
| normalizers.js | - | ~280 lines |
| assembler.js | - | ~200 lines |
| hydration.js | - | ~100 lines |
| placeholders.js | - | ~180 lines |
| sessionBridge.js | - | ~40 lines |
| **Total** | **1200** | **1540** |

While total lines increased slightly, each file is now focused, testable, and easier to maintain.
