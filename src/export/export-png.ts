import type maplibregl from 'maplibre-gl';

/**
 * Render the current map view at a higher resolution and trigger a PNG
 * download. We resize the map container in place, wait for tiles to load,
 * snapshot the canvas, then restore. The user briefly sees a flicker — the
 * trade-off for not maintaining a second offscreen renderer.
 */
export async function exportPng(opts: {
  map: maplibregl.Map;
  width: number;
  height: number;
  filename: string;
  onStatus?: (msg: string) => void;
}): Promise<void> {
  const { map, width, height, filename, onStatus } = opts;
  const container = map.getContainer();

  const oldStyle = {
    width: container.style.width,
    height: container.style.height,
    position: container.style.position,
  };
  const oldCenter = map.getCenter();
  const oldZoom = map.getZoom();
  const oldBearing = map.getBearing();
  const oldPitch = map.getPitch();

  try {
    onStatus?.('Resizing map…');
    // Position absolutely so the resize doesn't push DOM around.
    container.style.position = 'fixed';
    container.style.left = '0';
    container.style.top = '0';
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    map.resize();
    map.jumpTo({ center: oldCenter, zoom: oldZoom, bearing: oldBearing, pitch: oldPitch });

    onStatus?.('Loading tiles…');
    await waitForIdle(map, 8000);

    onStatus?.('Encoding PNG…');
    const blob = await new Promise<Blob | null>((resolve) =>
      map.getCanvas().toBlob((b) => resolve(b), 'image/png'),
    );
    if (!blob) throw new Error('toBlob returned null');

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onStatus?.('Done.');
  } finally {
    container.style.position = oldStyle.position;
    container.style.width = oldStyle.width;
    container.style.height = oldStyle.height;
    container.style.left = '';
    container.style.top = '';
    map.resize();
    map.jumpTo({ center: oldCenter, zoom: oldZoom, bearing: oldBearing, pitch: oldPitch });
  }
}

function waitForIdle(map: maplibregl.Map, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = () => {
      map.off('idle', onIdle);
      if (timer) clearTimeout(timer);
    };
    const onIdle = () => {
      off();
      resolve();
    };
    timer = setTimeout(() => {
      off();
      resolve(); // Resolve anyway so export doesn't hang forever.
    }, timeoutMs);
    map.once('idle', onIdle);
  });
}
