import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { InMemoryRepository } from './repository.js';
import { createApiRouter } from './api.js';
import { createTeamRouter } from './teams.js';

// Teams give a group access to every server the team holds. These tests drive the
// real routers against the in-memory repository, with the principal stubbed in
// place of requireAuth (which has its own tests in auth.test.ts).

const LEAD = { id: 'user-lead', email: 'lead@example.com', platformRole: 'user' as const };
const MEMBER = { id: 'user-member', email: 'member@example.com', platformRole: 'user' as const };
const OUTSIDER = { id: 'user-outsider', email: 'outsider@example.com', platformRole: 'user' as const };

const allowQuota: Parameters<typeof createApiRouter>[0]['checkQuota'] = async () => ({ allowed: true, limit: Infinity });

function appFor(repo: InMemoryRepository, principal: { id: string; platformRole: 'owner' | 'admin' | 'user' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { principal?: unknown; userId?: string }).principal = principal;
    (req as express.Request & { userId?: string }).userId = principal.id;
    next();
  });
  app.use(createTeamRouter({ repo }));
  app.use(createApiRouter({ repo, checkQuota: allowQuota, publish: async () => true }));
  return app;
}

describe('teams', () => {
  let repo: InMemoryRepository;
  let leadApp: express.Express;
  let memberApp: express.Express;
  let outsiderApp: express.Express;
  let teamId: string;
  let deploymentId: string;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    for (const u of [LEAD, MEMBER, OUTSIDER]) {
      await repo.createUser({ id: u.id, email: u.email, displayName: u.id, passwordHash: '!', platformRole: 'user' });
    }
    await repo.upsertNode({ id: 'node-local', name: 'node-local', lastHeartbeat: new Date().toISOString(), cpuPercent: 5, ramUsedMb: 500, ramTotalMb: 8000 });

    leadApp = appFor(repo, LEAD);
    memberApp = appFor(repo, MEMBER);
    outsiderApp = appFor(repo, OUTSIDER);

    teamId = (await request(leadApp).post('/teams').send({ name: 'Platform' })).body.id;
    deploymentId = (await request(leadApp).post('/deployments').send({ name: 'team-svc', dockerImage: 'nginx' })).body.id;
    await repo.updateDeploymentStatus(deploymentId, { status: 'running', containerId: 'c1', nodeId: 'node-local' });
  });

  const addMember = (role = 'operator') => request(leadApp).post(`/teams/${teamId}/members`).send({ email: MEMBER.email, role });
  const shareWithTeam = (id: string | null = teamId) => request(leadApp).patch(`/deployments/${deploymentId}/team`).send({ teamId: id });

  describe('membership', () => {
    it('creates a team owned by its creator and lists it for them', async () => {
      const list = await request(leadApp).get('/teams');
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ name: 'Platform', ownerId: LEAD.id });
    });

    it('adds a member by email and shows them with their account details', async () => {
      expect((await addMember()).status).toBe(201);
      const detail = await request(leadApp).get(`/teams/${teamId}`);
      expect(detail.body.members).toHaveLength(1);
      expect(detail.body.members[0]).toMatchObject({ userId: MEMBER.id, email: MEMBER.email, role: 'operator' });
    });

    it('refuses to add an address that has no account yet', async () => {
      // Unlike a per-server invitation, membership grants access to every server
      // the team holds, so it must not wait on an unclaimed address.
      const res = await request(leadApp).post(`/teams/${teamId}/members`).send({ email: 'nobody@example.com', role: 'viewer' });
      expect(res.status).toBe(404);
    });

    it('refuses an ungrantable role', async () => {
      expect((await addMember('owner')).status).toBe(400);
      expect((await addMember('superuser')).status).toBe(400);
    });

    it('hides a team from people who are not in it, as 404', async () => {
      expect((await request(outsiderApp).get(`/teams/${teamId}`)).status).toBe(404);
      expect((await request(outsiderApp).get('/teams')).body).toEqual([]);
    });

    it('lets only the owner add, re-role and remove other members', async () => {
      await addMember();
      expect((await request(memberApp).post(`/teams/${teamId}/members`).send({ email: OUTSIDER.email, role: 'viewer' })).status).toBe(403);
      expect((await request(memberApp).patch(`/teams/${teamId}/members/${MEMBER.id}`).send({ role: 'admin' })).status).toBe(403);
      expect((await request(memberApp).delete(`/teams/${teamId}/members/${OUTSIDER.id}`)).status).toBe(403);
    });

    it('hides an unknown or invisible team behind 404 on every route (#224)', async () => {
      // The guard runs before the handlers, so this holds for routes nobody has
      // written yet as much as for these — which is the point of moving it there.
      const routes = [
        () => request(outsiderApp).get(`/teams/${teamId}`),
        () => request(outsiderApp).delete(`/teams/${teamId}`),
        () => request(outsiderApp).post(`/teams/${teamId}/members`).send({ email: MEMBER.email, role: 'viewer' }),
        () => request(outsiderApp).patch(`/teams/${teamId}/members/${MEMBER.id}`).send({ role: 'viewer' }),
        () => request(outsiderApp).delete(`/teams/${teamId}/members/${OUTSIDER.id}`),
      ];
      for (const call of routes) expect((await call()).status).toBe(404);
      expect((await request(leadApp).get('/teams/no-such-team')).status).toBe(404);
    });

    it('refuses a member before the handler validates anything (#224)', async () => {
      await addMember();
      // A nonsense role would be a 400 if the request got as far as validation;
      // authorization is settled first, so it never does.
      const res = await request(memberApp).post(`/teams/${teamId}/members`).send({ email: OUTSIDER.email, role: 'nonsense' });
      expect(res.status).toBe(403);
    });

    it('lets a member remove themselves', async () => {
      await addMember();
      expect((await request(memberApp).delete(`/teams/${teamId}/members/${MEMBER.id}`)).status).toBe(204);
      expect(await repo.getTeamMember(teamId, MEMBER.id)).toBeNull();
    });
  });

  describe('sharing a server with a team', () => {
    it('gives every member their team role on it', async () => {
      await addMember('operator');
      await shareWithTeam();

      const list = await request(memberApp).get('/deployments');
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ id: deploymentId, role: 'operator' });
      expect((await request(memberApp).post(`/deployments/${deploymentId}/restart`)).status).toBe(202);
      // Still an operator, so the limits of that role hold.
      expect((await request(memberApp).get(`/deployments/${deploymentId}/backups`)).status).toBe(403);
    });

    it('grants nothing to someone outside the team', async () => {
      await addMember();
      await shareWithTeam();
      expect((await request(outsiderApp).get(`/deployments/${deploymentId}`)).status).toBe(404);
    });

    it('takes access away again when the server is detached', async () => {
      await addMember();
      await shareWithTeam();
      expect((await request(memberApp).get(`/deployments/${deploymentId}`)).status).toBe(200);

      await shareWithTeam(null);
      expect((await request(memberApp).get(`/deployments/${deploymentId}`)).status).toBe(404);
    });

    it('takes access away again when the member is removed', async () => {
      await addMember();
      await shareWithTeam();
      await request(leadApp).delete(`/teams/${teamId}/members/${MEMBER.id}`);
      expect((await request(memberApp).get(`/deployments/${deploymentId}`)).status).toBe(404);
      expect((await request(memberApp).get('/deployments')).body.items).toEqual([]);
    });

    it('takes the stronger of a direct share and team membership', async () => {
      await addMember('viewer');
      await shareWithTeam();
      await request(leadApp).post(`/deployments/${deploymentId}/subusers`).send({ email: MEMBER.email, role: 'admin' });

      const list = await request(memberApp).get('/deployments');
      expect(list.body.items[0].role).toBe('admin');
      expect((await request(memberApp).get(`/deployments/${deploymentId}/backups`)).status).toBe(200);
    });

    it('refuses to attach a server to a team the caller is not in', async () => {
      const otherTeam = (await request(outsiderApp).post('/teams').send({ name: 'Theirs' })).body.id;
      expect((await request(leadApp).patch(`/deployments/${deploymentId}/team`).send({ teamId: otherTeam })).status).toBe(404);
    });

    it('lets only someone with ownership attach a server', async () => {
      await addMember('admin');
      await shareWithTeam();
      // A server-level admin manages the server but does not decide who it is
      // shared with as a group — that is an ownership decision.
      expect((await request(memberApp).patch(`/deployments/${deploymentId}/team`).send({ teamId: null })).status).toBe(403);
    });
  });

  describe('deleting a team', () => {
    it('detaches its servers instead of deleting them', async () => {
      await addMember();
      await shareWithTeam();
      expect((await request(leadApp).delete(`/teams/${teamId}`)).status).toBe(204);

      // The server survives and stays with its owner; the member loses access.
      expect((await request(leadApp).get(`/deployments/${deploymentId}`)).status).toBe(200);
      expect((await request(memberApp).get(`/deployments/${deploymentId}`)).status).toBe(404);
    });

    it('may only be done by the team owner', async () => {
      await addMember();
      expect((await request(memberApp).delete(`/teams/${teamId}`)).status).toBe(403);
    });
  });
});
