import { useEffect, useState } from 'react';
import { listEggs, listNodes, updateDeployment, type DeploymentDetail, type Egg, type NodeView } from '../api';
import { capMbOf, limitChoiceFrom, withSizeLimits, type LimitChoice } from '../limits';
import { derivedHeapMb } from '../memory';
import { InfoHint } from './InfoHint';
import { LimitField } from './LimitField';
import { useToast } from './Toast';

/**
 * Resize a server after creation (#381).
 *
 * Until this existed a server's CPU and memory were fixed at creation — and with
 * them the Java heap, which follows the memory limit (#308). The Settings tab
 * told people to change the limit here while nothing here could, so a server
 * made too small had to be deleted and made again.
 *
 * Memory is the one number set. For a server with a JVM heap the heap the new
 * limit will give is shown while the value changes; the API derives it on save,
 * so the two cannot be saved out of step.
 */
export function ResourcesEditor({ deployment, onSaved }: { deployment: DeploymentDetail; onSaved: () => Promise<void> | void }) {
  const { toast } = useToast();
  const [choice, setChoice] = useState<LimitChoice>(() => limitChoiceFrom(deployment.resourceLimits));
  const [node, setNode] = useState<NodeView | null>(null);
  const [egg, setEgg] = useState<Egg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listNodes()
      .then((nodes) => setNode(nodes.find((n) => n.id === deployment.nodeId) ?? null))
      .catch(() => undefined);
    void listEggs()
      .then((list) => setEgg(list.find((e) => e.id === deployment.type) ?? null))
      .catch(() => undefined);
  }, [deployment.nodeId, deployment.type]);

  const set = (patch: Partial<LimitChoice>) => setChoice((prev) => ({ ...prev, ...patch }));
  const capacity = node?.capacity;
  const nodeRamMb = capacity?.ramTotalMb ?? node?.ramTotalMb ?? null;
  const nodeCores = capacity?.cpuCoresTotal ?? node?.cpuCores ?? null;

  // Switching unit converts the amount rather than resetting it — the size is
  // the same, only how it is written changes (#275).
  const switchRam = (next: 'mb' | 'percent') => {
    if (next === choice.ramUnit) return;
    if (next === 'mb' && nodeRamMb) set({ ramUnit: next, ramMb: Math.round((choice.ramPercent / 100) * nodeRamMb) });
    else if (next === 'percent' && nodeRamMb && choice.ramMb > 0) set({ ramUnit: next, ramPercent: Math.max(1, Math.round((choice.ramMb / nodeRamMb) * 100)) });
    else set({ ramUnit: next });
  };
  const switchCpu = (next: 'cores' | 'percent') => {
    if (next === choice.cpuUnit) return;
    if (next === 'cores' && nodeCores) set({ cpuUnit: next, cpuCores: Math.round((choice.cpuPercent / 100) * nodeCores * 10) / 10 });
    else if (next === 'percent' && nodeCores && choice.cpuCores > 0) set({ cpuUnit: next, cpuPercent: Math.max(1, Math.round((choice.cpuCores / nodeCores) * 100)) });
    else set({ cpuUnit: next });
  };

  const heapVariable = egg?.memoryVariable;
  const capMb = capMbOf(choice, nodeRamMb);
  const heapMb = heapVariable ? derivedHeapMb(capMb) : null;
  const currentHeap = heapVariable ? deployment.env?.[heapVariable] : undefined;
  // A cap no JVM fits in. The API refuses it too; saying so here saves the trip.
  const tooSmall = Boolean(heapVariable) && capMb != null && heapMb == null;

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      // No heap is sent: its absence is what tells the API to derive one from
      // the new limit (#308).
      await updateDeployment(deployment.id, { resourceLimits: withSizeLimits(deployment.resourceLimits, choice) });
      toast('Resources saved — they apply the next time this server starts', 'success', 'Settings');
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the resources');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: '20px 22px', marginBottom: 18 }}>
      <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 6 }}>
        Resources
        <InfoHint
          text="How much CPU and memory this server may use. The limits are enforced on the container when it starts, so a change applies on the next start."
          label="Resources help"
        />
      </strong>
      <p className="subtle" style={{ margin: '0 0 16px', fontSize: '.84rem' }}>
        Changes take effect the next time this server starts. 0 means no limit.
      </p>

      <LimitField
        label="CPU limit"
        unit={choice.cpuUnit}
        onUnitChange={switchCpu}
        units={[
          { value: 'cores', label: 'cores' },
          { value: 'percent', label: '%' },
        ]}
        hint="The most CPU this server may use. The container is throttled above it."
        absoluteValue={choice.cpuCores}
        onAbsoluteChange={(v) => set({ cpuCores: v })}
        absoluteStep={0.5}
        absoluteMax={nodeCores ?? undefined}
        percentValue={choice.cpuPercent}
        onPercentChange={(v) => set({ cpuPercent: v })}
        note={nodeCores != null ? `${node?.name ?? 'This node'} has ${nodeCores} cores` : undefined}
      />
      <LimitField
        label="RAM limit"
        unit={choice.ramUnit}
        onUnitChange={switchRam}
        units={[
          { value: 'mb', label: 'MB' },
          { value: 'percent', label: '%' },
        ]}
        hint="The most memory this server may use. A Java server's heap is worked out from it."
        absoluteValue={choice.ramMb}
        onAbsoluteChange={(v) => set({ ramMb: v })}
        absoluteStep={256}
        absoluteMax={nodeRamMb ?? undefined}
        percentValue={choice.ramPercent}
        onPercentChange={(v) => set({ ramPercent: v })}
        note={
          capacity?.ramAvailableMb != null
            ? `${capacity.ramAvailableMb} MB of ${capacity.ramTotalMb} MB uncommitted on ${node?.name ?? 'this node'}`
            : capMb != null && choice.ramUnit === 'percent'
              ? `${capMb} MB on ${node?.name ?? 'this node'}`
              : undefined
        }
      />

      {heapVariable && (
        <p
          role={tooSmall ? 'alert' : undefined}
          className={tooSmall ? 'alert alert--error' : 'subtle'}
          style={{ margin: '0 0 14px', fontSize: '.84rem' }}
          data-testid="heap-preview"
        >
          {tooSmall ? (
            <>A {capMb} MB limit is too small to run a Java server at all — Java needs several hundred megabytes beyond its heap.</>
          ) : heapMb != null ? (
            <>
              Java heap: <strong className="mono">{heapMb} MB</strong>, from the {capMb} MB limit
              {currentHeap && currentHeap !== `${heapMb}M` ? <> (now {currentHeap})</> : null}. It follows the limit — there is no second
              number to set.
            </>
          ) : capMb == null && choice.ramUnit === 'percent' ? (
            <>This node has not reported its memory yet, so no heap can be worked out from a percentage. Set the limit in MB.</>
          ) : (
            <>Without a memory limit the heap stays at <strong className="mono">{currentHeap ?? 'the image default'}</strong>.</>
          )}
        </p>
      )}

      {error && (
        <p role="alert" className="alert alert--error" style={{ margin: '0 0 14px', fontSize: '.84rem' }}>
          {error}
        </p>
      )}
      <button className="btn btn--primary btn--sm" data-ripple onClick={() => void save()} disabled={busy || tooSmall}>
        {busy ? 'Saving…' : 'Save resources'}
      </button>
    </div>
  );
}
