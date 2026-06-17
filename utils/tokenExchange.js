const axios = require('axios');

const FB_API_VERSION = process.env.FB_API_VERSION || "v23.0";

/**
 * Exchange short-lived access token for long-lived access token
 * @param {string} shortLivedToken - Short-lived access token
 * @returns {Promise<{access_token: string, token_type: string, expires_in: number}>} Long-lived token response
 */
async function exchangeForLongLivedToken(shortLivedToken) {
  try {
    const FB_APP_ID = process.env.FB_APP_ID;
    const FB_APP_SECRET = process.env.FB_APP_SECRET;

    if (!FB_APP_ID || !FB_APP_SECRET) {
      throw new Error('FB_APP_ID and FB_APP_SECRET must be set in environment variables');
    }

    const url = `https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`;
    const response = await axios.get(url, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        fb_exchange_token: shortLivedToken
      }
    });

    if (response.data.access_token) {
      console.log('✅ Successfully exchanged short-lived token for long-lived token');
      return {
        access_token: response.data.access_token,
        token_type: response.data.token_type || 'bearer',
        expires_in: response.data.expires_in || 5184000 // Default 60 days in seconds
      };
    } else {
      throw new Error('No access token in response');
    }
  } catch (error) {
    console.error('Error exchanging token:', error.response?.data || error.message);
    throw new Error(`Failed to exchange token: ${error.response?.data?.error?.message || error.message}`);
  }
}

/**
 * Exchange user access token for page access token
 * @param {string} userToken - User access token
 * @param {string} pageId - Facebook Page ID
 * @returns {Promise<string>} Page access token
 */
async function getUserPages(userToken) {
  try {
    const url = `https://graph.facebook.com/v24.0/me/accounts`;
    const response = await axios.get(url, {
      params: {
        access_token: userToken
      }
    });

    return response.data.data || [];
  } catch (error) {
    console.error('Error fetching user pages:', error.response?.data || error.message);
    throw new Error(`Failed to fetch user pages: ${error.response?.data?.error?.message || error.message}`);
  }
}

/**
 * Get page access token for a specific page
 * @param {string} userToken - User access token
 * @param {string} pageId - Facebook Page ID
 * @returns {Promise<string>} Page access token
 */
async function getPageToken(userToken, pageId) {
  try {
    const pages = await getUserPages(userToken);
    const page = pages.find(p => p.id === pageId || p.id === String(pageId));
    
    if (!page) {
      throw new Error(`Page ${pageId} not found or user doesn't have access to it`);
    }

    return page.access_token;
  } catch (error) {
    console.error('Error getting page token:', error.message);
    throw error;
  }
}

module.exports = {
  exchangeForLongLivedToken,
  getUserPages,
  getPageToken
};

