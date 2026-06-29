const axios = require('axios');

class ClickToCallService {
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
      // Remove 'act_' prefix if present
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/campaigns`;
      
      // Meta API expects form-encoded data - use URLSearchParams
      const params = new URLSearchParams();
      params.append('name', campaignData.name);
      params.append('objective', campaignData.objective);
      params.append('status', campaignData.status || 'PAUSED');
      params.append('access_token', fbToken);
      params.append('is_adset_budget_sharing_enabled', 'false');
      
      // special_ad_categories should be JSON string
      const specialAdCategories = campaignData.special_ad_categories || ['NONE'];
      params.append('special_ad_categories', JSON.stringify(specialAdCategories));

      console.log('Creating campaign with URL:', url);
      console.log('Campaign Name:', campaignData.name);
      console.log('Objective:', campaignData.objective);
      console.log('Status:', campaignData.status || 'PAUSED');
      console.log('Special Ad Categories:', specialAdCategories);

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
      // Remove 'act_' prefix if present
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/adsets`;
      
      // Build targeting object properly
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
      
      if (adsetData.targeting?.facebook_positions && adsetData.targeting.facebook_positions.length > 0) {
        targeting.facebook_positions = adsetData.targeting.facebook_positions;
        if (!determinedPlatforms.includes('facebook')) {
          determinedPlatforms.push('facebook');
        }
      }
      if (adsetData.targeting?.instagram_positions && adsetData.targeting.instagram_positions.length > 0) {
        // Filter valid Instagram positions and handle explore requirement
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
      if (!targeting.targeting_automation) {
        targeting.targeting_automation = {};
      }
      targeting.targeting_automation.advantage_audience = 0; // Default to disabled
      
      // Meta API expects form-encoded data - use URLSearchParams
      const params = new URLSearchParams();
      params.append('name', adsetData.name);
      params.append('campaign_id', adsetData.campaign_id);
      params.append('bid_strategy', 'LOWEST_COST_WITHOUT_CAP');
     

      params.append('daily_budget', adsetData.daily_budget);
      params.append('destination_type', 'PHONE_CALL');
      params.append('optimization_goal',  'QUALITY_CALL');
      params.append('billing_event', 'IMPRESSIONS');
      params.append('status', adsetData.status || 'PAUSED');
      params.append('access_token', fbToken);
   
      // Add targeting if it has values - Meta API expects JSON string
      if (Object.keys(targeting).length > 0) {
        params.append('targeting', JSON.stringify(targeting));
        console.log('📤 Full targeting object being sent to Meta:', JSON.stringify(targeting, null, 2));
      }

      console.log('Creating ad set with URL:', url);
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
      // Remove 'act_' prefix if present
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/adcreatives`;
      
      let objectStorySpec;
      
      // Check if video_id is provided - use video_data for videos
      if (creativeData.video_id) {
        // For video ads, use video_data
        const videoData = {
          video_id: creativeData.video_id,
          message: creativeData.primary_text || "",
          call_to_action: {
            type: 'CALL_NOW',
            value: {
              link: `tel:${creativeData.phone_number}`
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
        // Note: Meta API does NOT support 'description' field in video_data
        if (creativeData.headline && creativeData.headline.trim()) {
          videoData.title = creativeData.headline.trim();
        }
        
        objectStorySpec = {
          page_id: creativeData.page_id,
          video_data: videoData
        };
        
        console.log('📹 Creating Call video ad creative');
      } else {
        // For image ads, use link_data. Prefer a Meta image_hash (uploaded to
        // Meta); fall back to a hosted picture URL if that's what was provided.
        const linkData = {
          link: creativeData.business_page_url,
          message: creativeData.primary_text || "",
          call_to_action: {
            type: 'CALL_NOW',
            value: {
              link: `tel:${creativeData.phone_number}`
            }
          }
        };
        if (creativeData.headline && creativeData.headline.trim()) {
          linkData.name = creativeData.headline.trim();
        }
        if (creativeData.description && creativeData.description.trim()) {
          linkData.description = creativeData.description.trim();
        }
        if (creativeData.image_hash) {
          linkData.image_hash = creativeData.image_hash;
          console.log('✅ Using image_hash for image creative:', creativeData.image_hash);
        } else if (creativeData.picture_url) {
          linkData.picture = creativeData.picture_url;
          console.log('✅ Using picture URL for image creative:', creativeData.picture_url);
        }
        objectStorySpec = {
          page_id: creativeData.page_id,
          link_data: linkData
        };

        console.log('🖼️ Creating Call image ad creative');
      }
      
      // Meta API expects form-encoded data - use URLSearchParams
      const params = new URLSearchParams();
      params.append('name', creativeData.name);
      params.append('object_story_spec', JSON.stringify(objectStorySpec));
      params.append('access_token', fbToken);

      console.log('Creating ad creative with URL:', url);
      console.log('Ad Creative Name:', creativeData.name);
      console.log('Page ID:', creativeData.page_id);
      console.log('Video ID:', creativeData.video_id || 'N/A (using image)');
      console.log('Picture URL:', creativeData.picture_url || 'N/A (using video)');
      console.log('Business Page URL:', creativeData.business_page_url);
      console.log('Phone Number:', creativeData.phone_number);
      console.log('Object Story Spec:', JSON.stringify(objectStorySpec, null, 2));

      const response = await axios.post(url, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      return response.data;
    } catch (error) {
      const errorDetails = error.response?.data?.error || {};
      // Prefer Meta's human-readable reason (error_user_msg) over the generic
      // "Invalid parameter" so the UI tells the user what's actually wrong.
      const errorMessage =
        errorDetails.error_user_msg ||
        errorDetails.error_user_title ||
        errorDetails.message ||
        error.message ||
        'Failed to create ad creative';

      console.error('Meta API Error Details:', {
        message: errorMessage,
        type: errorDetails.type,
        code: errorDetails.code,
        error_subcode: errorDetails.error_subcode,
        error_user_title: errorDetails.error_user_title,
        error_user_msg: errorDetails.error_user_msg,
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
      // Remove 'act_' prefix if present
      const accountId = actAdAccountId.startsWith('act_') 
        ? actAdAccountId.replace('act_', '') 
        : actAdAccountId;
      
      const url = `${this.baseURL}/act_${accountId}/ads`;
      
      // Meta API expects form-encoded data - use URLSearchParams
      const params = new URLSearchParams();
      params.append('adset_id', adData.adset_id);
      params.append('creative', JSON.stringify({ creative_id: adData.creative_id }));
      params.append('status', adData.status || 'PAUSED');
      params.append('access_token', fbToken);
      params.append('name',  "Click to Call Ad - Test 1");      
      console.log('Creating ad with URL:', url);
      console.log('Ad Set ID:', adData.adset_id);
      console.log('Creative ID:', adData.creative_id);
      console.log('Status:', adData.status || 'PAUSED');

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

  
}

module.exports = new ClickToCallService();
