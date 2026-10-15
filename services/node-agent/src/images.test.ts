import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createImageRouter, digestOf, imageUpdateStatus } from './images.js';
import type { ContainerRuntime } from './runtime.js';

const A = 'sha256:aaaa';
const B = 'sha256:bbbb';

describe('imageUpdateStatus (#239)', () => {
  it('is current when the registry, the local tag and the container all agree', () => {
    expect(
      imageUpdateStatus({ remoteDigest: A, localRepoDigests: [`nginx@${A}`], localImageId: 'img-1', containerImageId: 'img-1' })
    ).toBe('current');
  });

  it('reports an update when the registry has a digest this node has never pulled', () => {
    expect(imageUpdateStatus({ remoteDigest: B, localRepoDigests: [`nginx@${A}`], localImageId: 'img-1', containerImageId: 'img-1' })).toBe(
      'update-available'
    );
  });

  it('notices a newer image that was pulled but is not what the container runs', () => {
    // Someone pulled; the server still runs the old one until it is recreated.
    expect(imageUpdateStatus({ remoteDigest: A, localRepoDigests: [`nginx@${A}`], localImageId: 'img-2', containerImageId: 'img-1' })).toBe(
      'pulled-not-applied'
    );
  });

  it('says it does not know when the registry could not be asked, rather than "current"', () => {
    expect(imageUpdateStatus({ remoteDigest: null, localRepoDigests: [`nginx@${A}`], localImageId: 'img-1', containerImageId: 'img-1' })).toBe(
      'unknown'
    );
  });

  it('treats an image that is not on the node at all as needing a pull', () => {
    expect(imageUpdateStatus({ remoteDigest: A, localRepoDigests: [], localImageId: null, containerImageId: null })).toBe('update-available');
  });

  it('judges a stopped server by the local image alone', () => {
    expect(imageUpdateStatus({ remoteDigest: A, localRepoDigests: [`nginx@${A}`], localImageId: 'img-1', containerImageId: null })).toBe('current');
  });
});

describe('digestOf', () => {
  it('takes the digest out of a repo digest', () => {
    expect(digestOf(`docker.io/library/nginx@${A}`)).toBe(A);
    expect(digestOf('nonsense')).toBeNull();
  });
});

describe('image router', () => {
  const runtime = {
    imageFacts: async (image: string, containerId?: string) => ({
      image,
      remoteDigest: B,
      localRepoDigests: [`nginx@${A}`],
      localImageId: 'img-1',
      containerImageId: containerId ? 'img-1' : null,
    }),
  } as unknown as ContainerRuntime;
  const app = express().use(createImageRouter(runtime));

  it('answers the status with the facts it was derived from', async () => {
    const res = await request(app).get('/images/status').query({ image: 'nginx', containerId: 'c1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ image: 'nginx', status: 'update-available', remoteDigest: B, localDigest: A });
  });

  it('needs an image', async () => {
    await request(app).get('/images/status').expect(400);
  });
});
