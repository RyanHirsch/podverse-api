import { getRepository } from 'typeorm'
import { config } from '~/config'
import { Episode, MediaRef, RecentEpisodeByCategory, RecentEpisodeByPodcast } from '~/entities'
import { request } from '~/lib/request'
import { getQueryOrderColumn } from '~/lib/utility'
import { createMediaRef, updateMediaRef } from './mediaRef'
const createError = require('http-errors')
const { superUserId } = config

const relations = [
  'authors', 'categories', 'podcast', 'podcast.feedUrls',
  'podcast.authors', 'podcast.categories'
]

const getEpisode = async id => {
  const repository = getRepository(Episode)
  const episode = await repository.findOne({
    id
  }, { relations })
  
  if (!episode) {
    throw new createError.NotFound('Episode not found')
  } else if (!episode.isPublic) {
    // If a public version of the episode isn't available, check if a newer public version
    // of the episode is available and return that. Don't return the non-public version
    // because it is more likely to contain a dead / out-of-date mediaUrl.
    // Non-public episodes may be attached to old mediaRefs that are still accessible on clip pages.
    const publicEpisode = await repository.findOne({
      isPublic: true,
      podcastId: episode.podcastId,
      title: episode.title
    }, { relations })

    if (publicEpisode) return publicEpisode
  }

  return episode
}

// Use where clause to reduce the size of very large data sets and speed up queries
const limitEpisodesQuerySize = (qb: any, shouldLimit: boolean, sort: string) => {
  if (shouldLimit) {
    if (sort === 'top-past-hour') {
      qb.andWhere('episode."pastHourTotalUniquePageviews" > 0')
    } else if (sort === 'top-past-day') {
      qb.andWhere('episode."pastDayTotalUniquePageviews" > 0')
    } else if (sort === 'top-past-week') {
      qb.andWhere('episode."pastWeekTotalUniquePageviews" > 0')
    } else if (sort === 'top-past-month') {
      qb.andWhere('episode."pastMonthTotalUniquePageviews" > 0')
    } else if (sort === 'top-past-year') {
      qb.andWhere('episode."pastYearTotalUniquePageviews" > 0')
    } else if (sort === 'top-all-time') {
      qb.andWhere('episode."pastAllTimeTotalUniquePageviews" > 0')
    } else if (sort === 'most-recent') {
      const date = new Date()
      date.setDate(date.getDate() - 1)
      const dateString = date.toISOString().slice(0, 19).replace('T', ' ')
      qb.andWhere(`episode."pubDate" > '${dateString}'`)
    }
  }

  return qb
}

const generateEpisodeSelects = (includePodcast, searchAllFieldsText = '') => {
  const qb = getRepository(Episode)
    .createQueryBuilder('episode')
    .select('episode.id')
    .addSelect('episode.description')
    .addSelect('episode.duration')
    .addSelect('episode.episodeType')
    .addSelect('episode.funding')
    .addSelect('episode.guid')
    .addSelect('episode.imageUrl')
    .addSelect('episode.isExplicit')
    .addSelect('episode.isPublic')
    .addSelect('episode.linkUrl')
    .addSelect('episode.mediaFilesize')
    .addSelect('episode.mediaType')
    .addSelect('episode.mediaUrl')
    .addSelect('episode.pastHourTotalUniquePageviews')
    .addSelect('episode.pastDayTotalUniquePageviews')
    .addSelect('episode.pastWeekTotalUniquePageviews')
    .addSelect('episode.pastMonthTotalUniquePageviews')
    .addSelect('episode.pastYearTotalUniquePageviews')
    .addSelect('episode.pastAllTimeTotalUniquePageviews')
    .addSelect('episode.pubDate')
    .addSelect('episode.title')

  qb[`${includePodcast ? 'innerJoinAndSelect' : 'innerJoin'}`](
    'episode.podcast',
    'podcast'
  )

  qb.where(
    `${searchAllFieldsText ? 'LOWER(episode.title) LIKE :searchAllFieldsText' : 'true'}`,
    {
      searchAllFieldsText: `%${searchAllFieldsText.toLowerCase().trim()}%`
    }
  )

  return qb    
}

// Limit the description length since we don't need the full description in list views.
const cleanEpisodes = (episodes) => {
  return episodes.map((x) => {
    x.description = x.description ? x.description.substr(0, 2500) : '';
    return x
  })
}

const handleMostRecentEpisodesQuery = async (qb, type, ids, skip, take) => {
  const table = type === 'categoriesIds' ? RecentEpisodeByCategory : RecentEpisodeByPodcast
  const select = type === 'categoriesIds' ? 'recentEpisode.categoryId' : 'recentEpisode.podcastId'
  const where = type === 'categoriesIds' ? 'recentEpisode.categoryId IN (:...ids)' : 'recentEpisode.podcastId IN (:...ids)'

  const recentEpisodesResult = await getRepository(table)
    .createQueryBuilder('recentEpisode')
    .select('recentEpisode.episodeId')
    .addSelect(select)
    .addSelect('recentEpisode.pubDate')
    .where(where, { ids })
    .orderBy('recentEpisode.pubDate', 'DESC')
    .offset(skip)
    .limit(take)
    .getManyAndCount()

  const totalCount = recentEpisodesResult[1]
  if (!totalCount) return [[], 0]

  const recentEpisodeIds = recentEpisodesResult[0].map(x => x.episodeId)
  if (recentEpisodeIds.length <= 0) return [[], totalCount]

  qb.andWhere('episode.id IN (:...recentEpisodeIds)', { recentEpisodeIds })
  
  const episodes = await qb.getMany()
  const cleanedEpisodes = cleanEpisodes(episodes)
  return [cleanedEpisodes, totalCount]
}

const handleGetEpisodesWithOrdering = async (obj) => {
  const { qb, query, skip, sort, take } = obj
  qb.offset(skip)
  qb.limit(take)

  const orderColumn = getQueryOrderColumn('episode', sort, 'pubDate')
  query.sort === 'random' ? qb.orderBy(orderColumn[0]) : qb.orderBy(orderColumn[0], orderColumn[1] as any)

  const episodesResults = await qb.getManyAndCount()
  const episodes = episodesResults[0]
  const episodesCount = episodesResults[1]

  const cleanedEpisodes = cleanEpisodes(episodes)

  return [cleanedEpisodes, episodesCount]
}

const getEpisodes = async (query) => {
  const { includePodcast, searchAllFieldsText, skip, sort, take } = query

  let qb = generateEpisodeSelects(includePodcast, searchAllFieldsText)
  const shouldLimit = true
  qb = limitEpisodesQuerySize(qb, shouldLimit, sort)
  qb.andWhere('episode."isPublic" IS true')

  return handleGetEpisodesWithOrdering({ qb, query, skip, sort, take })
}

const getEpisodesByCategoryIds = async (query) => {
  const { categories, includePodcast, searchAllFieldsText, skip, sort, take } = query
  const categoriesIds = categories && categories.split(',') || []

  let qb = generateEpisodeSelects(includePodcast, searchAllFieldsText)

  if (sort === 'most-recent') {
    return handleMostRecentEpisodesQuery(qb, 'categoriesIds', categoriesIds, skip, take)
  } else {
    qb.innerJoin(
      'podcast.categories',
      'categories',
      'categories.id IN (:...categoriesIds)',
      { categoriesIds }
    )
    
    const shouldLimit = true
    qb = limitEpisodesQuerySize(qb, shouldLimit, sort)
    qb.andWhere('episode."isPublic" IS true')

    return handleGetEpisodesWithOrdering({ qb, query, skip, sort, take })
  }
}

const getEpisodesByPodcastId = async (query, qb, podcastIds) => {
  const { skip, sort, take } = query
  qb.andWhere('episode.podcastId IN(:...podcastIds)', { podcastIds })
  qb.andWhere('episode."isPublic" IS true')

  return handleGetEpisodesWithOrdering({ qb, query, skip, sort, take })
}

const getEpisodesByPodcastIds = async (query) => {
  const { includePodcast, podcastId, searchAllFieldsText, skip, sort, take } = query
  const podcastIds = podcastId && podcastId.split(',') || []

  let qb = generateEpisodeSelects(includePodcast, searchAllFieldsText)

  if (podcastIds.length === 1) {
    return getEpisodesByPodcastId(query, qb, podcastIds)
  }
  
  if (sort === 'most-recent') {
    return handleMostRecentEpisodesQuery(qb, 'podcastIds', podcastIds, skip, take)
  } else {
    qb.andWhere('episode.podcastId IN(:...podcastIds)', { podcastIds })
    const shouldLimit = podcastIds.length > 10
    qb = limitEpisodesQuerySize(qb, shouldLimit, sort)
    qb.andWhere('episode."isPublic" IS true')

    return handleGetEpisodesWithOrdering({ qb, query, skip, sort, take })
  }
}

const getDeadEpisodes = async () => {
  const repository = getRepository(Episode)

  const qb = repository
    .createQueryBuilder('episode')
    .select('episode.id', 'id')
    .where('episode."isPublic" = FALSE AND mediaRef.id IS NULL')
    .leftJoin(
      'episode.mediaRefs',
      'mediaRef'
    )
    .limit(100)

  const episodes = await qb.getRawMany()
  console.log('dead episode count:', episodes.length)

  return episodes
}

const removeDeadEpisodes = async () => {
  const deadEpisodes = await getDeadEpisodes()
  await removeEpisodes(deadEpisodes)
  await new Promise(r => setTimeout(r, 1000));
  const shouldContinue = deadEpisodes.length === 100
  return shouldContinue
}

const removeEpisodes = async (episodes: any[]) => {
  const repository = getRepository(Episode)
  for (const episode of episodes) {
    await repository.remove(episode)
  }
}

const retrieveLatestChapters = async (id) => {
  const episodeRepository = getRepository(Episode)
  const mediaRefRepository = getRepository(MediaRef)

  const qb = episodeRepository
    .createQueryBuilder('episode')
    .select('episode.id', 'id')
    .addSelect('episode.chaptersUrl', 'chaptersUrl')
    .addSelect('episode.chaptersUrlLastParsed', 'chaptersUrlLastParsed')
    .where('episode.id = :id', { id })

  const episode = await qb.getRawOne() as Episode
  if (!episode) throw new Error('Episode not found') 
  const { chaptersUrl, chaptersUrlLastParsed } = episode

  // Update the latest chapters only once every 12 hours for an episode.
  // If less than 12 hours, then just return the latest chapters from the database.
  const halfDay = new Date().getTime() + (1 * 12 * 60 * 60 * 1000)
  const chaptersUrlLastParsedDate = new Date(chaptersUrlLastParsed).getTime()

  if (chaptersUrl && (!chaptersUrlLastParsed || halfDay < chaptersUrlLastParsedDate)) {
    try {
      await episodeRepository.update(episode.id, { chaptersUrlLastParsed: new Date() })
      const response = await request(chaptersUrl)
      const parsedResponse = JSON.parse(response)
      const { chapters: newChapters } = parsedResponse
      if (newChapters) {
        const qb = mediaRefRepository
          .createQueryBuilder('mediaRef')
          .select('mediaRef.id', 'id')
          .addSelect('mediaRef.isOfficialChapter', 'isOfficialChapter')
          .addSelect('mediaRef.startTime', 'startTime')
          .where('mediaRef.isOfficialChapter = TRUE')
        const existingChapters = await qb.getRawMany()

        // If existing chapter with current chapter's startTime does not exist,
        // then set the existingChapter to isPublic = false.
        const deadChapters = existingChapters.filter(x => {
          return newChapters.every(y => y.startTime !== x.startTime)
        })

        for (const deadChapter of deadChapters) {
          await updateMediaRef({
            ...deadChapter,
            isPublic: false
          }, superUserId)
        }

        for (const newChapter of newChapters) {
          try {
            // If a chapter with that startTime already exists, then update it.
            // If it does not exist, then create a new mediaRef with isOfficialChapter = true.
            const existingChapter = existingChapters.find(x => x.startTime === newChapter.startTime)
            if (existingChapter && existingChapter.id) {
              await updateMediaRef({
                id: existingChapter.id,
                imageUrl: newChapter.img || null,
                isOfficialChapter: true,
                isPublic: true,
                linkUrl: newChapter.url || null,
                startTime: newChapter.startTime,
                title: newChapter.title,
                episodeId: id
              }, superUserId)
            } else {
              await createMediaRef({
                imageUrl: newChapter.img || null,
                isOfficialChapter: true,
                isPublic: true,
                linkUrl: newChapter.url || null,
                startTime: newChapter.startTime,
                title: newChapter.title,
                owner: superUserId,
                episodeId: id
              })
            }
          } catch (error) {
            console.log('retrieveLatestChapters newChapter', error)
          }
        }
      }
    } catch (error) {
      console.log('retrieveLatestChapters request', error)
    }
  }

  const officialChaptersForEpisode = await mediaRefRepository
    .createQueryBuilder('mediaRef')
    .select('mediaRef.id')
    .addSelect('mediaRef.endTime')
    .addSelect('mediaRef.imageUrl')
    .addSelect('mediaRef.isOfficialChapter')
    .addSelect('mediaRef.linkUrl')
    .addSelect('mediaRef.startTime')
    .addSelect('mediaRef.title')
    .where({
      isOfficialChapter: true,
      episode: id
    })
    .orderBy('mediaRef.startTime', 'ASC')
    .getManyAndCount()

  return officialChaptersForEpisode
}

export {
  getEpisode,
  getEpisodes,
  getEpisodesByCategoryIds,
  getEpisodesByPodcastIds,
  removeDeadEpisodes,
  retrieveLatestChapters
}
