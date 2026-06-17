const axios = require('axios');

class ClickToWhatsAppService {
  constructor() {
    this.baseURL = 'https://graph.facebook.com/v24.0';
  }

  /**
   * Create a campaign using Meta Marketing API
   * @param {string} actAdAccountId - Ad Account ID
   * @param {string} fbToken - Facebook Access Token
   * @param {Object} campaignData - Campaign data
   * @returns {Promise<Object>} Created campaign response
   */
  async createCampaign(actAdAccountId, fbToken, campaignData) {
    try {
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/campaigns`;
      
      const params = new URLSearchParams();
      params.append('name', campaignData.name);
      params.append('objective', campaignData.objective);
      params.append('status', campaignData.status || 'PAUSED');
      params.append('access_token', fbToken);
      params.append('is_adset_budget_sharing_enabled', 'false');
      
      const specialAdCategories = campaignData.special_ad_categories || ['NONE'];
      params.append('special_ad_categories', JSON.stringify(specialAdCategories));

      console.log('Creating WhatsApp campaign with URL:', url);
      console.log('Campaign Name:', campaignData.name);
      console.log('Objective:', campaignData.objective);

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to create campaign';
      const errorDetails = error.response?.data?.error || {};
      
      console.error('Meta API Error Details:', {
        message: errorMessage,
        type: errorDetails.type,
        code: errorDetails.code,
        error_subcode: errorDetails.error_subcode,
        fbtrace_id: errorDetails.fbtrace_id,
        fullError: JSON.stringify(error.response?.data, null, 2)
      });
      
      throw new Error(`${errorMessage}${errorDetails.code ? ` (Code: ${errorDetails.code})` : ''}`);
    }
  }

  /**
   * Create an ad set using Meta Marketing API
   * @param {string} actAdAccountId - Ad Account ID
   * @param {string} fbToken - Facebook Access Token
   * @param {Object} adsetData - Ad Set data
   * @returns {Promise<Object>} Created ad set response
   */
  async createAdSet(actAdAccountId, fbToken, adsetData) {
    try {
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/adsets`;
      
      const targeting = {};
      
      // Build geo_locations object
      const geoLocations = {};
      
      // Meta API doesn't allow both custom_locations and countries together (causes overlap error 1487756)
      // Priority: Use custom_locations if provided, otherwise use countries
      if (adsetData.targeting?.geo_locations?.custom_locations && adsetData.targeting.geo_locations.custom_locations.length > 0) {
        // Validate and format custom_locations
        geoLocations.custom_locations = adsetData.targeting.geo_locations.custom_locations.map(loc => ({
          latitude: parseFloat(loc.latitude),
          longitude: parseFloat(loc.longitude),
          radius: parseInt(loc.radius) || 10,
          distance_unit: loc.distance_unit || "kilometer"
        }));
        
        console.log("✅ Using custom_locations for targeting (countries excluded to avoid overlap):", geoLocations.custom_locations);
      } else if (adsetData.targeting?.geo_locations?.countries && adsetData.targeting.geo_locations.countries.length > 0) {
        // Only use countries if no custom_locations are provided
        geoLocations.countries = adsetData.targeting.geo_locations.countries;
        console.log("✅ Using countries for targeting:", geoLocations.countries);
      }
      
      // Set geo_locations in targeting if we have any location data
      if (Object.keys(geoLocations).length > 0) {
        targeting.geo_locations = geoLocations;
      }
      if (adsetData.targeting?.device_platforms && adsetData.targeting.device_platforms.length > 0) {
        targeting.device_platforms = adsetData.targeting.device_platforms;
      }
      if (adsetData.targeting?.age_min) {
        targeting.age_min = adsetData.targeting.age_min;
      }
      if (adsetData.targeting?.age_max) {
        targeting.age_max = adsetData.targeting.age_max;
      }
      if (adsetData.targeting?.genders && adsetData.targeting.genders.length > 0) {
        targeting.genders = adsetData.targeting.genders;
      }
      
      // Handle publisher platforms and positions together
      // Meta API: If positions are specified, platforms are inferred, but we should still send publisher_platforms
      // Determine platforms based on positions if not explicitly provided
      let determinedPlatforms = [];
      
      // Filter valid Facebook positions for WhatsApp ads
      // For WhatsApp destination type, only 'feed' and 'instant_article' are typically valid
      // Invalid for WhatsApp: right_column, video_feeds, instream_video, rewarded_video
      if (adsetData.targeting?.facebook_positions && adsetData.targeting.facebook_positions.length > 0) {
        const validFacebookPositions = ['feed', 'instant_article'];
        const filteredFacebookPositions = adsetData.targeting.facebook_positions.filter(pos => 
          validFacebookPositions.includes(pos)
        );
        if (filteredFacebookPositions.length > 0) {
          targeting.facebook_positions = filteredFacebookPositions;
          if (!determinedPlatforms.includes('facebook')) {
            determinedPlatforms.push('facebook');
          }
        }
      }
      
      // Filter valid Instagram positions
      // Valid positions: stream (feed), reels, story, explore
      // Note: If explore is selected, stream (feed) must also be included
      if (adsetData.targeting?.instagram_positions && adsetData.targeting.instagram_positions.length > 0) {
        const validInstagramPositions = ['stream', 'reels', 'story', 'explore'];
        let filteredInstagramPositions = adsetData.targeting.instagram_positions.filter(pos => 
          validInstagramPositions.includes(pos)
        );
        
        // If explore is selected, ensure stream (feed) is also included
        if (filteredInstagramPositions.includes('explore') && !filteredInstagramPositions.includes('stream')) {
          filteredInstagramPositions.push('stream');
        }
        
        if (filteredInstagramPositions.length > 0) {
          targeting.instagram_positions = filteredInstagramPositions;
          if (!determinedPlatforms.includes('instagram')) {
            determinedPlatforms.push('instagram');
          }
        }
      }
      
      // Set publisher_platforms - prioritize explicit selection, fallback to determined from positions
      // Valid values: "facebook", "instagram", "messenger", "audience_network", "threads"
      const validPlatforms = ["facebook", "instagram", "messenger", "audience_network", "threads"];
      
      if (adsetData.targeting?.publisher_platforms && adsetData.targeting.publisher_platforms.length > 0) {
        // Use explicitly provided platforms
        targeting.publisher_platforms = adsetData.targeting.publisher_platforms
          .map(p => String(p).toLowerCase())
          .filter(p => validPlatforms.includes(p));
        console.log('✅ Publisher platforms from explicit selection:', targeting.publisher_platforms);
      } else if (determinedPlatforms.length > 0) {
        // Use platforms determined from positions
        targeting.publisher_platforms = determinedPlatforms;
        console.log('✅ Publisher platforms determined from positions:', targeting.publisher_platforms);
      } else {
        // Default to facebook and instagram if nothing is provided
        targeting.publisher_platforms = ["facebook", "instagram"];
        console.log('⚠️ No publisher platforms provided, defaulting to:', targeting.publisher_platforms);
      }

      // Add detailed targeting (interests, work_positions, work_employers)
      // Meta API requires these to be in flexible_spec array format
      // Combine all detailed targeting into a single flexible_spec object
      const flexibleSpecObj = {};
      let hasDetailedTargeting = false;
      
      if (adsetData.targeting?.interests && adsetData.targeting.interests.length > 0) {
        // Ensure interests is an array of IDs (strings or numbers)
        flexibleSpecObj.interests = adsetData.targeting.interests.map(id => String(id));
        hasDetailedTargeting = true;
        console.log('✅ Adding interests to flexible_spec:', flexibleSpecObj.interests);
      }
      if (adsetData.targeting?.work_positions && adsetData.targeting.work_positions.length > 0) {
        // Ensure work_positions is an array of IDs (strings or numbers)
        flexibleSpecObj.work_positions = adsetData.targeting.work_positions.map(id => String(id));
        hasDetailedTargeting = true;
        console.log('✅ Adding work_positions to flexible_spec:', flexibleSpecObj.work_positions);
      }
      if (adsetData.targeting?.work_employers && adsetData.targeting.work_employers.length > 0) {
        // Ensure work_employers is an array of IDs (strings or numbers)
        flexibleSpecObj.work_employers = adsetData.targeting.work_employers.map(id => String(id));
        hasDetailedTargeting = true;
        console.log('✅ Adding work_employers to flexible_spec:', flexibleSpecObj.work_employers);
      }
      
      // Add flexible_spec to targeting if we have any detailed targeting
      if (hasDetailedTargeting) {
        targeting.flexible_spec = [flexibleSpecObj];
        console.log('✅ Added flexible_spec to targeting:', JSON.stringify(targeting.flexible_spec, null, 2));
      }

      // Add targeting_automation with advantage_audience flag (required by Meta API)
      // advantage_audience: 1 = enabled, 0 = disabled
      // Default to 0 (disabled) for more control
      if (!targeting.targeting_automation) {
        targeting.targeting_automation = {};
      }
      targeting.targeting_automation.advantage_audience = 0; // Default to disabled
      
      const params = new URLSearchParams();
      params.append('name', adsetData.name);
      params.append('campaign_id', adsetData.campaign_id);
      params.append('bid_strategy', 'LOWEST_COST_WITHOUT_CAP');
      params.append('daily_budget', adsetData.daily_budget);
      params.append('optimization_goal', 'CONVERSATIONS');
      params.append('destination_type', 'WHATSAPP');
      params.append('status', adsetData.status || 'PAUSED');
      params.append('access_token', fbToken);
      params.append('billing_event', 'IMPRESSIONS');

      // Add promoted_object with page_id for WhatsApp destination
      if (adsetData.page_id) {
        const promotedObject = {
          page_id: adsetData.page_id
        };
        params.append('promoted_object', JSON.stringify(promotedObject));
      }

      if (Object.keys(targeting).length > 0) {
        params.append('targeting', JSON.stringify(targeting));
        console.log('📤 Full targeting object being sent to Meta:', JSON.stringify(targeting, null, 2));
      }

      console.log('Creating WhatsApp ad set with URL:', url);
      console.log('Ad Set Name:', adsetData.name);
      console.log('Campaign ID:', adsetData.campaign_id);
      console.log('📋 Received targeting from frontend:', JSON.stringify(adsetData.targeting, null, 2));

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to create ad set';
      const errorDetails = error.response?.data?.error || {};
      
      console.error('Meta API Error Details:', {
        message: errorMessage,
        type: errorDetails.type,
        code: errorDetails.code,
        error_subcode: errorDetails.error_subcode,
        fbtrace_id: errorDetails.fbtrace_id,
        fullError: JSON.stringify(error.response?.data, null, 2)
      });
      
      throw new Error(`${errorMessage}${errorDetails.code ? ` (Code: ${errorDetails.code})` : ''}`);
    }
  }

  /**
   * Create an ad creative using Meta Marketing API
   * @param {string} actAdAccountId - Ad Account ID
   * @param {string} fbToken - Facebook Access Token
   * @param {Object} creativeData - Ad Creative data
   * @returns {Promise<Object>} Created ad creative response
   */
  async createAdCreative(actAdAccountId, fbToken, creativeData) {
    try {
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/adcreatives`;
      
      let objectStorySpec;
      
      // Check if video_id is provided - use video_data for videos
      if (creativeData.video_id) {
        // For video ads, use video_data
        // Meta API requires image_hash or image_url in video_data for video thumbnail
        const videoData = {
          video_id: creativeData.video_id,
          message: creativeData.primary_text || "",
          call_to_action: {
            type: "WHATSAPP_MESSAGE",
            value: {
              app_destination: "WHATSAPP"
            }
          }
        };
        
        // Add image_hash or image_url for video thumbnail (REQUIRED by Meta API)
        if (creativeData.image_hash) {
          videoData.image_hash = creativeData.image_hash;
          console.log('✅ Using image_hash for video thumbnail:', creativeData.image_hash);
        } else if (creativeData.picture_url) {
          videoData.image_url = creativeData.picture_url;
          console.log('✅ Using image_url for video thumbnail:', creativeData.picture_url);
        } else {
          console.warn('⚠️ WARNING: No image_hash or image_url provided for video thumbnail. Meta API may reject this.');
        }
        
        // Add optional fields for video_data
        // Note: Meta API does NOT support 'description' field in video_data for WhatsApp ads (error 1443050)
        // Only 'title' is supported for video_data
        if (creativeData.headline && creativeData.headline.trim()) {
          videoData.title = creativeData.headline.trim();
        }
        // Description is NOT supported in video_data - Meta API will reject it
        // If description is needed, it should be in the ad creative name or message field
        
        objectStorySpec = {
          page_id: creativeData.page_id,
          video_data: videoData
        };
        
        console.log('📹 Creating WhatsApp video ad creative');
      } else {
        // For image ads, use link_data
        objectStorySpec = {
          page_id: creativeData.page_id,
          link_data: {
            picture: creativeData.picture_url,
            link: creativeData.business_page_url,
            call_to_action: {
              type: "WHATSAPP_MESSAGE",
              value: {
                app_destination: "WHATSAPP"
              }
            }
          }
        };
        
        console.log('🖼️ Creating WhatsApp image ad creative');
      }
      
      const params = new URLSearchParams();
      params.append('name', creativeData.name);
      params.append('object_story_spec', JSON.stringify(objectStorySpec));
      params.append('access_token', fbToken);

      console.log('Creating WhatsApp ad creative with URL:', url);
      console.log('Ad Creative Name:', creativeData.name);
      console.log('Page ID:', creativeData.page_id);
      console.log('Video ID:', creativeData.video_id || 'N/A (using image)');
      console.log('Picture URL:', creativeData.picture_url || 'N/A (using video)');
      console.log('Description received:', creativeData.description || 'N/A');
      console.log('Object Story Spec:', JSON.stringify(objectStorySpec, null, 2));

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to create ad creative';
      const errorDetails = error.response?.data?.error || {};
      
      console.error('Meta API Error Details:', {
        message: errorMessage,
        type: errorDetails.type,
        code: errorDetails.code,
        error_subcode: errorDetails.error_subcode,
        fbtrace_id: errorDetails.fbtrace_id,
        fullError: JSON.stringify(error.response?.data, null, 2)
      });
      
      throw new Error(`${errorMessage}${errorDetails.code ? ` (Code: ${errorDetails.code})` : ''}`);
    }
  }

  /**
   * Create an ad using Meta Marketing API
   * @param {string} actAdAccountId - Ad Account ID
   * @param {string} fbToken - Facebook Access Token
   * @param {Object} adData - Ad data
   * @returns {Promise<Object>} Created ad response
   */
  async createAd(actAdAccountId, fbToken, adData) {
    try {
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/ads`;
      
      const params = new URLSearchParams();
      params.append('adset_id', adData.adset_id);
      params.append('creative', JSON.stringify({ creative_id: adData.creative_id }));
      params.append('status', adData.status || 'PAUSED');
      params.append('access_token', fbToken);
      params.append('name', 'Click to WhatsApp Ad - Test 1');

      console.log('Creating WhatsApp ad with URL:', url);
      console.log('Ad Set ID:', adData.adset_id);
      console.log('Creative ID:', adData.creative_id);

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to create ad';
      const errorDetails = error.response?.data?.error || {};
      
      console.error('Meta API Error Details:', {
        message: errorMessage,
        type: errorDetails.type,
        code: errorDetails.code,
        error_subcode: errorDetails.error_subcode,
        fbtrace_id: errorDetails.fbtrace_id,
        fullError: JSON.stringify(error.response?.data, null, 2)
      });
      
      throw new Error(`${errorMessage}${errorDetails.code ? ` (Code: ${errorDetails.code})` : ''}`);
    }
  }

  /**
   * Verify WhatsApp number for a page
   * @param {string} pageId - Facebook Page ID
   * @param {string} pageAccessToken - Page Access Token
   * @param {Object} verificationData - Verification data (whatsapp_number, verification_code optional)
   * @returns {Promise<Object>} Verification response
   */
  async verifyWhatsAppNumber(pageId, pageAccessToken, verificationData) {
    try {
      const url = `${this.baseURL}/${pageId}/page_whatsapp_number_verification`;
      
      const params = new URLSearchParams();
      params.append('whatsapp_number', verificationData.whatsapp_number);
      if (verificationData.verification_code) {
        params.append('verification_code', verificationData.verification_code);
      }
      params.append('access_token', pageAccessToken);

      console.log('Verifying WhatsApp number with URL:', url);
      console.log('Page ID:', pageId);
      console.log('WhatsApp Number:', verificationData.whatsapp_number);
      if (verificationData.verification_code) {
        console.log('Verification Code:', verificationData.verification_code);
      }

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorMessage = error.response?.data?.error?.message || error.message || 'Failed to verify WhatsApp number';
      const errorDetails = error.response?.data?.error || {};
      
      console.error('Meta API Error Details:', {
        message: errorMessage,
        type: errorDetails.type,
        code: errorDetails.code,
        error_subcode: errorDetails.error_subcode,
        fbtrace_id: errorDetails.fbtrace_id,
        fullError: JSON.stringify(error.response?.data, null, 2)
      });
      
      throw new Error(`${errorMessage}${errorDetails.code ? ` (Code: ${errorDetails.code})` : ''}`);
    }
  }
}

module.exports = new ClickToWhatsAppService();
