import nock from 'nock';
import { expect } from 'chai';

import { podcastQueue, OgQueueAdd } from '../../src/asyncTasks'
import Podcast from '../../src/models/podcast';
import Episode from '../../src/models/episode';
import { ParsePodcast } from '../../src/parsers/feed';
import { podcastProcessor, handlePodcast } from '../../src/workers/podcast';
import { loadFixture, dropDBs, getTestPodcast, getMockFeed } from '../utils';

describe('Podcast worker', () => {
	let handler;

	function setupHandler() {
		handler = new Promise((resolve, reject) => {
			podcastQueue.handlers['__default__'] = job => {
				return handlePodcast(job).then(resolve, reject);
			};
		});
	}

	before(async () => {
		await dropDBs();
		await loadFixture('initial-data');
	});

	after(() => {
		podcastQueue.handlers['__default__'] = podcastProcessor;
	});

	describe('queue', () => {
		it('should call worker when enqueueing jobs', async () => {
			setupHandler();

			const data = {
				podcast: '5afb7fedfe7430d35996d66e',
				url: 'http://mbmbam.libsyn.com/rss'
			};

			await podcastQueue.add(data);
			await handler;
		});

		it('should fail for invalid job', async () => {
			const testCases = [
				{ podcast: '5afb7fedfe7430d35996d66e', url: undefined },
				{ podcast: '5afb7fedfe7430d35996d66e', url: '' },
				{ podcast: '5afb7fedfe7430d35996d66e', url: 'http://dorkly.com/comics/rssss' },
			];

			for (let i = 0; i < testCases.length; ++i) {
				setupHandler();

				const data = testCases[i];
				await podcastQueue.add(data);
				try {
					await handler;
				} catch (err) {
					// ignore error
				}
				const podcast = await Podcast.findById(data.podcast);
				expect(podcast.consecutiveScrapeFailures).to.be.an.equal(i + 1);
			}
		});
	});

	describe('worker', () => {
		const data = {
			podcast: '5afb7fedfe7430d35996d66e',
			url: 'http://mbmbam.libsyn.com/rss'
		};
		let initialEpisodes;

		before(async () => {
			await dropDBs();
			await loadFixture('initial-data');

			initialEpisodes = await Episode.find({ podcast: data.podcast });

			nock(data.url).get('').reply(200, () => {
				return getTestPodcast('giant-bombcast');
			});

			getMockFeed('podcast', data.podcast).addActivities.resetHistory();
			ParsePodcast.resetHistory();
			OgQueueAdd.resetHistory();
			setupHandler();

			await podcastQueue.add(data);
			await handler;
		});

		after(() => {
			nock.cleanAll();
		});

		it('should parse the feed', async () => {
			expect(ParsePodcast.calledOnceWith(data.url)).to.be.true;
		});

		it('should upsert episode data from feed', async () => {
			const episodes = await Episode.find({ podcast: data.podcast });
			expect(episodes).to.have.length(initialEpisodes.length + 649);
		});

		it('should update feed data', async () => {
			const podcast = await Podcast.findById(data.podcast);
			expect(podcast.postCount).to.be.equal(initialEpisodes.length + 649);
		});

		it('should add episode data to Stream feed', async () => {
			const feed = getMockFeed('podcast', data.podcast);
			expect(feed).to.not.be.null;
			expect(feed.addActivities.called).to.be.true;

			const episodes = await Episode.find({
				_id: { $nin: initialEpisodes.map(a => a._id) },
				podcast: data.podcast,
			});
			const batchCount = Math.ceil(episodes.length / 100);
			const foreignIds = episodes.map(e => `episodes:${e._id}`);
			let matchedActivities = 0;
			for (let i = 0; i < batchCount; ++i) {
				const batchSize = Math.min(100, episodes.length - i * 100);
				const args = feed.addActivities.getCall(i).args[0].map(a => a.foreign_id);
				expect(args).to.have.length(batchSize);
				matchedActivities += args.filter(arg => foreignIds.includes(arg)).length;
			}
			expect(matchedActivities).to.equal(episodes.length);
		});

		it('should schedule OG job', async () => {
			const episodes = await Episode.find({
				_id: { $nin: initialEpisodes.map(a => a._id) },
				podcast: data.podcast,
			});
			expect(OgQueueAdd.getCalls()).to.have.length(649);

			const opts = { removeOnComplete: true, removeOnFail: true };
			for (const episode of episodes) {
				const args = { type: 'episode', url: episode.link };
				expect(OgQueueAdd.calledWith(args, opts), `Adding ${args.url} to OG queue`).to.be.true;
			}
		});
	});
});